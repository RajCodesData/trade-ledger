import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { deltaGetTicker, deltaGetCandles } from "../../../../lib/deltaExchange";

function isDelta(instrumentKey) { return instrumentKey.startsWith("DELTA|"); }
function deltaSymbol(instrumentKey) { return instrumentKey.split("|")[1]; }

async function fetchLtpUpstox(instrumentKey, accessToken) {
  const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success") return null;
  const key = Object.keys(data.data || {})[0];
  return key ? data.data[key].last_price : null;
}
async function fetchIntradayCandlesUpstox(instrumentKey, accessToken, tfMinutes) {
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${tfMinutes}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success" || !data.data?.candles?.length) return [];
  return data.data.candles.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] })).reverse();
}
async function fetchPrevDayLevelsUpstox(instrumentKey, accessToken) {
  const now = new Date();
  const to = new Date(now); to.setDate(to.getDate() - 1);
  const from = new Date(now); from.setDate(from.getDate() - 8);
  const url = `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/day/${to.toISOString().slice(0, 10)}/${from.toISOString().slice(0, 10)}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success" || !data.data?.candles?.length) return null;
  const latest = data.data.candles[0];
  return { high: latest[2], low: latest[3], open: latest[1] };
}

function timeframeToMinutes(tf) {
  return { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60 }[tf] || 5;
}
async function fetchLtp(instrumentKey, accessToken) {
  if (isDelta(instrumentKey)) return deltaGetTicker(deltaSymbol(instrumentKey));
  return fetchLtpUpstox(instrumentKey, accessToken);
}
async function fetchIntradayCandles(instrumentKey, accessToken, timeframe) {
  const tfMinutes = timeframeToMinutes(timeframe);
  if (isDelta(instrumentKey)) {
    const end = Math.floor(Date.now() / 1000);
    const start = end - tfMinutes * 60 * 70;
    return deltaGetCandles(deltaSymbol(instrumentKey), timeframe, start, end);
  }
  return fetchIntradayCandlesUpstox(instrumentKey, accessToken, tfMinutes);
}
async function fetchPrevDayLevels(instrumentKey, accessToken) {
  if (isDelta(instrumentKey)) {
    const now = new Date();
    const end = Math.floor(new Date(now.toDateString()).getTime() / 1000);
    const start = end - 60 * 60 * 24;
    const candles = await deltaGetCandles(deltaSymbol(instrumentKey), "1d", start, end);
    if (!candles.length) return null;
    const last = candles[candles.length - 1];
    return { high: last.high, low: last.low, open: last.open };
  }
  return fetchPrevDayLevelsUpstox(instrumentKey, accessToken);
}

function sma(closes, n) {
  if (closes.length < n) return null;
  return closes.slice(closes.length - n).reduce((s, v) => s + v, 0) / n;
}
function ema(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let v = closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
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
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function vwap(candles) {
  let cumPV = 0, cumV = 0;
  for (const c of candles) { cumPV += ((c.high + c.low + c.close) / 3) * c.volume; cumV += c.volume; }
  return cumV > 0 ? cumPV / cumV : null;
}
function trueRangeSeries(candles) {
  return candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
}
function wilderSmooth(arr, period) {
  const out = [];
  let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = sum;
  for (let i = period; i < arr.length; i++) { sum = out[i - 1] - out[i - 1] / period + arr[i]; out[i] = sum; }
  return out;
}
function adx(candles, period) {
  if (candles.length < period * 2) return null;
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = trueRangeSeries(candles);
  const trS = wilderSmooth(tr, period), plusS = wilderSmooth(plusDM, period), minusS = wilderSmooth(minusDM, period);
  const dx = [];
  for (let i = period - 1; i < candles.length; i++) {
    if (!trS[i]) continue;
    const plusDI = 100 * (plusS[i] / trS[i]), minusDI = 100 * (minusS[i] / trS[i]);
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dx.length < period) return null;
  let v = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) v = (v * (period - 1) + dx[i]) / period;
  return v;
}

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { instrumentKey, timeframe } = await request.json();
  if (!instrumentKey) return NextResponse.json({ error: "Instrument key is required." }, { status: 400 });

  let accessToken = null;
  if (!isDelta(instrumentKey)) {
    const { data: conn } = await supabaseAdmin.from("broker_connections").select("*").eq("user_id", userData.user.id).maybeSingle();
    if (!conn?.access_token) return NextResponse.json({ error: "Connect Upstox on the Broker tab first to preview NSE instruments." }, { status: 400 });
    accessToken = conn.access_token;
  }

  try {
    const candles = await fetchIntradayCandles(instrumentKey, accessToken, timeframe || "5m");
    if (candles.length < 2) return NextResponse.json({ error: "Not enough candle data available right now (market may be closed, or too early in the session)." }, { status: 400 });
    const prevLevels = await fetchPrevDayLevels(instrumentKey, accessToken);
    const ltp = await fetchLtp(instrumentKey, accessToken);
    const closes = candles.map((c) => c.close);

    const values = {
      price: ltp ?? closes[closes.length - 1],
      vwap: vwap(candles),
      day_open: candles[0]?.open ?? null,
      prev_day_high: prevLevels?.high ?? null,
      prev_day_low: prevLevels?.low ?? null,
      prev_candle_high: candles[candles.length - 2]?.high ?? null,
      prev_candle_low: candles[candles.length - 2]?.low ?? null,
      ema_9: ema(closes, 9),
      ema_21: ema(closes, 21),
      ema_50: ema(closes, 50),
      sma_20: sma(closes, 20),
      rsi_14: rsi(closes, 14),
      adx_14: adx(candles, 14),
    };

    return NextResponse.json({ values, candleCount: candles.length, timeframe: timeframe || "5m" });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Could not fetch indicator data." }, { status: 500 });
  }
}
