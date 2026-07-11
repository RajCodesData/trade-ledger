import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

// Called every few minutes by an external scheduler (Vercel's free tier only
// allows once-a-day cron). This NEVER places real orders - it only simulates
// trades based on live/intraday data and logs results to paper_trades.

function nowIST() {
  const now = new Date();
  return new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000);
}
function timeStrToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function todayIsoDate(ist) {
  return ist.toISOString().slice(0, 10);
}

async function fetchLtp(instrumentKey, accessToken) {
  const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success") return null;
  const key = Object.keys(data.data || {})[0];
  return key ? data.data[key].last_price : null;
}

// Returns today's intraday candles, oldest first: [{time, open, high, low, close, volume}]
async function fetchIntradayCandles(instrumentKey, accessToken) {
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/5`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success" || !data.data?.candles?.length) return [];
  return data.data.candles
    .map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .reverse(); // API returns newest-first; we want oldest-first for indicator math
}

async function fetchPrevDayLevels(instrumentKey, accessToken) {
  const ist = nowIST();
  const to = new Date(ist); to.setDate(to.getDate() - 1);
  const from = new Date(ist); from.setDate(from.getDate() - 8);
  const toStr = to.toISOString().slice(0, 10);
  const fromStr = from.toISOString().slice(0, 10);
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${toStr}/${fromStr}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success" || !data.data?.candles?.length) return null;
  const latest = data.data.candles[0];
  return { high: latest[2], low: latest[3], open: latest[1] };
}

// ---- indicator math ----
function sma(closes, n) {
  if (closes.length < n) return null;
  const slice = closes.slice(closes.length - n);
  return slice.reduce((s, v) => s + v, 0) / n;
}
function ema(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let emaVal = closes.slice(0, n).reduce((s, v) => s + v, 0) / n;
  for (let i = n; i < closes.length; i++) emaVal = closes[i] * k + emaVal * (1 - k);
  return emaVal;
}
function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function vwap(candles) {
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

function getMetric(name, ctx) {
  if (name === "price") return ctx.closes[ctx.closes.length - 1] ?? null;
  if (name === "vwap") return ctx.vwapVal;
  if (name === "day_open") return ctx.dayOpen;
  if (name === "prev_day_high") return ctx.prevHigh;
  if (name === "prev_day_low") return ctx.prevLow;
  let m;
  if ((m = /^sma_(\d+)$/.exec(name))) return sma(ctx.closes, parseInt(m[1]));
  if ((m = /^ema_(\d+)$/.exec(name))) return ema(ctx.closes, parseInt(m[1]));
  if ((m = /^rsi_(\d+)$/.exec(name))) return rsi(ctx.closes, parseInt(m[1]));
  return null;
}

function collectMetricNames(conditions) {
  const names = new Set();
  conditions.forEach((c) => {
    names.add(c.metric);
    if (c.value_type === "metric") names.add(c.value);
  });
  return Array.from(names);
}

function computeAllMetrics(names, ctx) {
  const out = {};
  names.forEach((n) => { out[n] = getMetric(n, ctx); });
  return out;
}

function evaluateCondition(cond, current, previous) {
  const left = current[cond.metric];
  const right = cond.value_type === "number" ? cond.value : current[cond.value];
  if (left == null || right == null) return false;
  if (cond.comparator === "above") return left > right;
  if (cond.comparator === "below") return left < right;
  const prevLeft = previous?.[cond.metric];
  const prevRight = cond.value_type === "number" ? cond.value : previous?.[cond.value];
  if (prevLeft == null || prevRight == null) return false;
  if (cond.comparator === "crosses_above") return prevLeft <= prevRight && left > right;
  if (cond.comparator === "crosses_below") return prevLeft >= prevRight && left < right;
  return false;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("secret") !== process.env.PAPER_ENGINE_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ist = nowIST();
  const day = ist.getDay();
  const nowMinutes = ist.getHours() * 60 + ist.getMinutes();
  const today = todayIsoDate(ist);
  const results = [];

  if (day === 0 || day === 6) return NextResponse.json({ skipped: "weekend" });

  const { data: strategies } = await supabaseAdmin.from("strategies").select("*").eq("active", true);
  if (!strategies?.length) return NextResponse.json({ ran: 0 });

  const userIds = Array.from(new Set(strategies.map((s) => s.user_id)));
  const { data: connections } = await supabaseAdmin.from("broker_connections").select("*").in("user_id", userIds);
  const connByUser = Object.fromEntries((connections || []).map((c) => [c.user_id, c]));

  for (const s of strategies) {
    const conn = connByUser[s.user_id];
    if (!conn?.access_token) { results.push({ strategy: s.id, skipped: "no broker connection" }); continue; }
    if (!s.entry_conditions?.length) { results.push({ strategy: s.id, skipped: "no conditions defined" }); continue; }

    const startMin = timeStrToMinutes(s.window_start);
    const endMin = timeStrToMinutes(s.window_end);

    const { data: openTrade } = await supabaseAdmin.from("paper_trades").select("*")
      .eq("strategy_id", s.id).eq("status", "open").eq("trade_date", today).maybeSingle();

    if (nowMinutes >= endMin) {
      if (openTrade) {
        const ltp = await fetchLtp(s.instrument_key, conn.access_token);
        if (ltp) {
          const pnl = s.direction === "long" ? (ltp - openTrade.entry_price) * s.qty : (openTrade.entry_price - ltp) * s.qty;
          await supabaseAdmin.from("paper_trades").update({ status: "closed", exit_price: ltp, exit_time: new Date().toISOString(), pnl }).eq("id", openTrade.id);
          results.push({ strategy: s.id, action: "force_closed_eod", pnl });
        }
      }
      continue;
    }
    if (nowMinutes < startMin) { results.push({ strategy: s.id, skipped: "before window" }); continue; }

    if (openTrade) {
      const ltp = await fetchLtp(s.instrument_key, conn.access_token);
      if (!ltp) { results.push({ strategy: s.id, skipped: "no ltp" }); continue; }
      const moveFavorable = s.direction === "long" ? ltp - openTrade.entry_price : openTrade.entry_price - ltp;
      const movePct = (moveFavorable / openTrade.entry_price) * 100;
      if (movePct <= -Math.abs(s.stop_loss_pct) || movePct >= Math.abs(s.target_pct)) {
        const pnl = moveFavorable * s.qty;
        await supabaseAdmin.from("paper_trades").update({ status: "closed", exit_price: ltp, exit_time: new Date().toISOString(), pnl }).eq("id", openTrade.id);
        results.push({ strategy: s.id, action: "closed", pnl });
      } else {
        results.push({ strategy: s.id, action: "holding" });
      }
      continue;
    }

    const candles = await fetchIntradayCandles(s.instrument_key, conn.access_token);
    if (candles.length < 2) { results.push({ strategy: s.id, skipped: "not enough candle data yet" }); continue; }
    const prevLevels = await fetchPrevDayLevels(s.instrument_key, conn.access_token);
    const closes = candles.map((c) => c.close);
    const ctx = {
      closes,
      vwapVal: vwap(candles),
      dayOpen: candles[0]?.open ?? null,
      prevHigh: prevLevels?.high ?? null,
      prevLow: prevLevels?.low ?? null,
    };

    const metricNames = collectMetricNames(s.entry_conditions);
    const currentMetrics = computeAllMetrics(metricNames, ctx);
    const previousMetrics = s.last_metrics || {};

    const allMet = s.entry_conditions.every((c) => evaluateCondition(c, currentMetrics, previousMetrics));

    await supabaseAdmin.from("strategies").update({ last_metrics: currentMetrics }).eq("id", s.id);

    if (allMet) {
      const entryPrice = currentMetrics.price ?? closes[closes.length - 1];
      await supabaseAdmin.from("paper_trades").insert({
        strategy_id: s.id, user_id: s.user_id, instrument_key: s.instrument_key,
        side: s.direction === "long" ? "buy" : "sell", entry_price: entryPrice,
        entry_time: new Date().toISOString(), status: "open", trade_date: today,
      });
      results.push({ strategy: s.id, action: "entered", price: entryPrice, metrics: currentMetrics });
    } else {
      results.push({ strategy: s.id, action: "waiting", metrics: currentMetrics });
    }
  }

  return NextResponse.json({ ran: strategies.length, results });
}
