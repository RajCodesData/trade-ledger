import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

// Upstox's "get-trades-for-day" API returns individual executed FILLS, not
// round-trip trades. We match BUY fills against SELL fills per instrument,
// FIFO, across today's fills PLUS any carried-forward open position from a
// previous day (e.g. a BTST buy from yesterday, sold today). Anything left
// unmatched after this run is saved back to open_positions for next time.

// Classifies a trade for tax purposes based on its symbol and product code.
// Options symbols end in CE/PE, futures end in FUT, everything else is equity.
// Product "D" = delivery, anything else (I, CO, MTF) is treated as intraday.
function classifySegment(symbol, product) {
  const s = (symbol || "").trim().toUpperCase();
  if (/(CE|PE)$/.test(s)) return "options";
  if (/FUT$/.test(s)) return "futures";
  if (product === "D") return "equity_delivery";
  return "equity_intraday";
}

async function matchFillsToTrades(fills, userId, supabase) {
  const byInstrument = {};
  fills.forEach((f) => {
    const key = f.trading_symbol || f.tradingsymbol;
    byInstrument[key] = byInstrument[key] || [];
    byInstrument[key].push(f);
  });

  const { data: existingOpen } = await supabase.from("open_positions").select("*").eq("user_id", userId);
  const openByInstrument = {};
  (existingOpen || []).forEach((p) => {
    openByInstrument[p.instrument] = openByInstrument[p.instrument] || [];
    openByInstrument[p.instrument].push(p);
  });

  const completedTrades = [];
  const positionUpserts = [];
  const positionIdsToDelete = [];
  const allInstruments = new Set([...Object.keys(byInstrument), ...Object.keys(openByInstrument)]);

  for (const instrument of allInstruments) {
    const list = (byInstrument[instrument] || []).slice();
    list.sort((a, b) => new Date(a.exchange_timestamp) - new Date(b.exchange_timestamp));
    const segment = classifySegment(instrument, list[0]?.product) ||
      (openByInstrument[instrument]?.[0]?.segment) || "equity_intraday";

    // Carried-forward positions act like fills that happened earlier, so they get matched first (FIFO).
    const carriedBuys = (openByInstrument[instrument] || []).filter((p) => p.side === "buy")
      .map((p) => ({ average_price: p.avg_price, remaining: p.remaining_qty, exchange_timestamp: p.opened_at, _carriedId: p.id }));
    const carriedSells = (openByInstrument[instrument] || []).filter((p) => p.side === "sell")
      .map((p) => ({ average_price: p.avg_price, remaining: p.remaining_qty, exchange_timestamp: p.opened_at, _carriedId: p.id }));

    const buys = [...carriedBuys, ...list.filter((f) => f.transaction_type === "BUY").map((f) => ({ ...f, remaining: f.quantity }))];
    const sells = [...carriedSells, ...list.filter((f) => f.transaction_type === "SELL").map((f) => ({ ...f, remaining: f.quantity }))];

    let bi = 0, si = 0;
    while (bi < buys.length && si < sells.length) {
      const b = buys[bi], s = sells[si];
      const matchQty = Math.min(b.remaining, s.remaining);
      if (matchQty > 0) {
        const buyFirst = new Date(b.exchange_timestamp) <= new Date(s.exchange_timestamp);
        completedTrades.push({
          user_id: userId,
          instrument,
          side: buyFirst ? "buy" : "sell",
          entry_price: buyFirst ? b.average_price : s.average_price,
          exit_price: buyFirst ? s.average_price : b.average_price,
          qty: matchQty,
          entry_time: buyFirst ? b.exchange_timestamp : s.exchange_timestamp,
          exit_time: buyFirst ? s.exchange_timestamp : b.exchange_timestamp,
          notes: "Auto-synced from Upstox" + (b._carriedId || s._carriedId ? " (multi-day position)" : ""),
          pnl: (s.average_price - b.average_price) * matchQty,
          source: "upstox",
          segment,
        });
        b.remaining -= matchQty;
        s.remaining -= matchQty;
      }
      if (b.remaining <= 0) { if (b._carriedId) positionIdsToDelete.push(b._carriedId); bi++; }
      if (s.remaining <= 0) { if (s._carriedId) positionIdsToDelete.push(s._carriedId); si++; }
    }

    // Anything still unmatched becomes (or updates) an open position to carry forward.
    for (let i = bi; i < buys.length; i++) {
      if (buys[i].remaining > 0) {
        if (buys[i]._carriedId) positionUpserts.push({ id: buys[i]._carriedId, user_id: userId, instrument, segment, side: "buy", remaining_qty: buys[i].remaining, avg_price: buys[i].average_price, opened_at: buys[i].exchange_timestamp, updated_at: new Date().toISOString() });
        else positionUpserts.push({ user_id: userId, instrument, segment, side: "buy", remaining_qty: buys[i].remaining, avg_price: buys[i].average_price, opened_at: buys[i].exchange_timestamp, updated_at: new Date().toISOString() });
      }
    }
    for (let i = si; i < sells.length; i++) {
      if (sells[i].remaining > 0) {
        if (sells[i]._carriedId) positionUpserts.push({ id: sells[i]._carriedId, user_id: userId, instrument, segment, side: "sell", remaining_qty: sells[i].remaining, avg_price: sells[i].average_price, opened_at: sells[i].exchange_timestamp, updated_at: new Date().toISOString() });
        else positionUpserts.push({ user_id: userId, instrument, segment, side: "sell", remaining_qty: sells[i].remaining, avg_price: sells[i].average_price, opened_at: sells[i].exchange_timestamp, updated_at: new Date().toISOString() });
      }
    }
  }

  return { completedTrades, positionUpserts, positionIdsToDelete };
}

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const userId = userData.user.id;

  const { data: conn } = await supabaseAdmin.from("broker_connections").select("*").eq("user_id", userId).maybeSingle();
  if (!conn?.access_token) return NextResponse.json({ error: "Upstox isn't connected yet." }, { status: 400 });

  try {
    const res = await fetch("https://api.upstox.com/v2/order/trades/get-trades-for-day", {
      headers: { Accept: "application/json", Authorization: `Bearer ${conn.access_token}` },
    });
    const data = await res.json();
    if (data.status !== "success") {
      return NextResponse.json({ error: "Upstox rejected the request. Your connection may have expired — tap Connect again." }, { status: 400 });
    }

    const { completedTrades, positionUpserts, positionIdsToDelete } = await matchFillsToTrades(data.data || [], userId, supabaseAdmin);

    // Avoid duplicate imports on repeated syncs: replace today's synced rows.
    await supabaseAdmin.from("trades").delete().eq("user_id", userId).eq("source", "upstox").gte("entry_time", new Date().toISOString().slice(0, 10));

    if (completedTrades.length > 0) {
      const { error: insertErr } = await supabaseAdmin.from("trades").insert(completedTrades);
      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    if (positionIdsToDelete.length > 0) {
      await supabaseAdmin.from("open_positions").delete().in("id", positionIdsToDelete);
    }
    if (positionUpserts.length > 0) {
      await supabaseAdmin.from("open_positions").upsert(positionUpserts);
    }

    return NextResponse.json({ imported: completedTrades.length, stillOpen: positionUpserts.length });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Sync failed." }, { status: 500 });
  }
}
