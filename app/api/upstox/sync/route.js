import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

// Upstox's "get-trades-for-day" API returns individual executed FILLS, not
// round-trip trades. A round trip (entry + exit) is what the journal needs,
// so we match BUY fills against SELL fills per instrument, FIFO, within the
// same day. This covers same-day intraday trading, which is the common case
// for auto-journaling. Multi-day swing trades aren't matched by this v1.
function matchFillsToTrades(fills, userId) {
  const byInstrument = {};
  fills.forEach((f) => {
    const key = f.trading_symbol || f.tradingsymbol;
    byInstrument[key] = byInstrument[key] || [];
    byInstrument[key].push(f);
  });

  const results = [];
  for (const [instrument, list] of Object.entries(byInstrument)) {
    list.sort((a, b) => new Date(a.exchange_timestamp) - new Date(b.exchange_timestamp));
    const buys = list.filter((f) => f.transaction_type === "BUY").map((f) => ({ ...f, remaining: f.quantity }));
    const sells = list.filter((f) => f.transaction_type === "SELL").map((f) => ({ ...f, remaining: f.quantity }));

    let bi = 0, si = 0;
    while (bi < buys.length && si < sells.length) {
      const b = buys[bi], s = sells[si];
      const matchQty = Math.min(b.remaining, s.remaining);
      if (matchQty > 0) {
        const buyFirst = new Date(b.exchange_timestamp) <= new Date(s.exchange_timestamp);
        results.push({
          user_id: userId,
          instrument,
          side: buyFirst ? "buy" : "sell",
          entry_price: buyFirst ? b.average_price : s.average_price,
          exit_price: buyFirst ? s.average_price : b.average_price,
          qty: matchQty,
          entry_time: buyFirst ? b.exchange_timestamp : s.exchange_timestamp,
          notes: "Auto-synced from Upstox",
          pnl: (s.average_price - b.average_price) * matchQty,
          source: "upstox",
        });
        b.remaining -= matchQty;
        s.remaining -= matchQty;
      }
      if (b.remaining <= 0) bi++;
      if (s.remaining <= 0) si++;
    }
  }
  return results;
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

    const matched = matchFillsToTrades(data.data || [], userId);

    // Avoid duplicate imports on repeated syncs: replace today's synced rows.
    await supabaseAdmin.from("trades").delete().eq("user_id", userId).eq("source", "upstox").gte("entry_time", new Date().toISOString().slice(0, 10));

    if (matched.length > 0) {
      const { error: insertErr } = await supabaseAdmin.from("trades").insert(matched);
      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    return NextResponse.json({ imported: matched.length });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Sync failed." }, { status: 500 });
  }
}
