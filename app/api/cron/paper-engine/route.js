import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { sendEmail } from "../../../../lib/sendEmail";
import { deltaGetTicker, deltaGetCandles, deltaGetProduct, deltaSetLeverage, deltaPlaceBracketEntry, deltaGetPosition } from "../../../../lib/deltaExchange";
import { decrypt } from "../../../../lib/crypto";
import { calculateRoundTripFees } from "../../../../lib/brokerFees";

const NAG_INTERVAL_MINUTES = 2;

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

// Instrument keys look like "NSE_INDEX|Nifty 50" (Upstox) or "DELTA|BTCUSD" (Delta Exchange).
function isDelta(instrumentKey) {
  return instrumentKey.startsWith("DELTA|");
}
function deltaSymbol(instrumentKey) {
  return instrumentKey.split("|")[1];
}

async function fetchLtpUpstox(instrumentKey, accessToken) {
  const url = `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success") return null;
  const key = Object.keys(data.data || {})[0];
  return key ? data.data[key].last_price : null;
}

// Returns today's intraday candles, oldest first: [{time, open, high, low, close, volume}]
async function fetchIntradayCandlesUpstox(instrumentKey, accessToken, timeframeMinutes) {
  const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/${timeframeMinutes}`;
  const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.status !== "success" || !data.data?.candles?.length) return [];
  return data.data.candles
    .map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .reverse(); // API returns newest-first; we want oldest-first for indicator math
}

async function fetchPrevDayLevelsUpstox(instrumentKey, accessToken) {
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

// ---- unified wrappers: route to Upstox or Delta based on the instrument key ----
async function fetchLtp(instrumentKey, accessToken) {
  if (isDelta(instrumentKey)) return deltaGetTicker(deltaSymbol(instrumentKey));
  return fetchLtpUpstox(instrumentKey, accessToken);
}

function timeframeToMinutes(tf) {
  const map = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60 };
  return map[tf] || 5;
}

async function fetchIntradayCandles(instrumentKey, accessToken, timeframe) {
  const tfMinutes = timeframeToMinutes(timeframe);
  if (isDelta(instrumentKey)) {
    const end = Math.floor(Date.now() / 1000);
    // Fetch enough history for ~70 candles at this timeframe, so indicators like EMA-50 have enough data.
    const start = end - tfMinutes * 60 * 70;
    return deltaGetCandles(deltaSymbol(instrumentKey), timeframe, start, end);
  }
  return fetchIntradayCandlesUpstox(instrumentKey, accessToken, tfMinutes);
}

async function fetchPrevDayLevels(instrumentKey, accessToken) {
  if (isDelta(instrumentKey)) {
    const ist = nowIST();
    const end = Math.floor(new Date(ist.toDateString()).getTime() / 1000); // start of today IST
    const start = end - 60 * 60 * 24;
    const candles = await deltaGetCandles(deltaSymbol(instrumentKey), "1d", start, end);
    if (!candles.length) return null;
    const last = candles[candles.length - 1];
    return { high: last.high, low: last.low, open: last.open };
  }
  return fetchPrevDayLevelsUpstox(instrumentKey, accessToken);
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

// ADX (Average Directional Index) - measures trend strength, not direction.
// Used purely as a filter: "only look for entries when the market is
// actually trending," layered on top of whatever entry logic already exists.
function trueRangeSeries(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
  });
}
function wilderSmooth(arr, period) {
  const out = [];
  let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = sum;
  for (let i = period; i < arr.length; i++) {
    sum = out[i - 1] - out[i - 1] / period + arr[i];
    out[i] = sum;
  }
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
  const trS = wilderSmooth(tr, period);
  const plusS = wilderSmooth(plusDM, period);
  const minusS = wilderSmooth(minusDM, period);

  const dx = [];
  for (let i = period - 1; i < candles.length; i++) {
    if (!trS[i]) continue;
    const plusDI = 100 * (plusS[i] / trS[i]);
    const minusDI = 100 * (minusS[i] / trS[i]);
    const sum = plusDI + minusDI;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum);
  }
  if (dx.length < period) return null;
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adxVal = (adxVal * (period - 1) + dx[i]) / period;
  return adxVal;
}

function getMetric(name, ctx) {
  if (name === "price") return ctx.closes[ctx.closes.length - 1] ?? null;
  if (name === "vwap") return ctx.vwapVal;
  if (name === "day_open") return ctx.dayOpen;
  if (name === "prev_day_high") return ctx.prevHigh;
  if (name === "prev_day_low") return ctx.prevLow;
  if (name === "prev_candle_high") return ctx.prevCandleHigh;
  if (name === "prev_candle_low") return ctx.prevCandleLow;
  let m;
  if ((m = /^sma_(\d+)$/.exec(name))) return sma(ctx.closes, parseInt(m[1]));
  if ((m = /^ema_(\d+)$/.exec(name))) return ema(ctx.closes, parseInt(m[1]));
  if ((m = /^rsi_(\d+)$/.exec(name))) return rsi(ctx.closes, parseInt(m[1]));
  if ((m = /^adx_(\d+)$/.exec(name))) return ctx.candles ? adx(ctx.candles, parseInt(m[1])) : null;
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

// Checking only the current price at each cron run can miss a stop/target
// that was touched and reversed between checks. This scans 1-minute candles
// since entry to catch that - much closer to what a real order would have done.
async function scanForTouchSinceEntry(instrumentKey, accessToken, entryTime, stopPrice, targetPrice, direction) {
  const candles = await fetchIntradayCandles(instrumentKey, accessToken, "1m");
  const entryMs = new Date(entryTime).getTime();
  for (const c of candles) {
    const cTime = typeof c.time === "number" ? c.time * 1000 : new Date(c.time).getTime();
    if (cTime < entryMs) continue;
    const stopHit = direction === "long" ? c.low <= stopPrice : c.high >= stopPrice;
    const targetHit = direction === "long" ? c.high >= targetPrice : c.low <= targetPrice;
    // If both were touched in the same candle we can't know which came first - assume the worse outcome (stop) for a conservative simulation.
    if (stopHit) return { hit: true, hitType: "stop", price: stopPrice };
    if (targetHit) return { hit: true, hitType: "target", price: targetPrice };
  }
  return { hit: false };
}

// Scans through today's candles bar-by-bar (like a real backtest would),
// instead of only checking the current instant. Catches an entry condition
// that became true and then reversed between cron checks - exactly the kind
// of miss that happens with a purely "check right now" approach.
function scanCandlesForEntry(candles, entryConditions, prevHigh, prevLow, windowStartMin, windowEndMin, extraMetricName, afterMs, latestOnly) {
  const metricNames = collectMetricNames(entryConditions);
  if (extraMetricName && !metricNames.includes(extraMetricName)) metricNames.push(extraMetricName);
  const startIdx = latestOnly ? Math.max(1, candles.length - 1) : 1;
  let prevMetrics = null;
  for (let i = startIdx; i < candles.length; i++) {
    const cTime = typeof candles[i].time === "number" ? new Date(candles[i].time * 1000) : new Date(candles[i].time);
    if (afterMs && cTime.getTime() <= afterMs) continue;
    const cIST = new Date(cTime.getTime() + (5.5 * 60 + cTime.getTimezoneOffset()) * 60000);
    const cMinutes = cIST.getHours() * 60 + cIST.getMinutes();
    if (cMinutes < windowStartMin || cMinutes > windowEndMin) { prevMetrics = null; continue; }

    const slice = candles.slice(0, i + 1);
    const ctx = {
      closes: slice.map((c) => c.close),
      candles: slice,
      vwapVal: vwap(slice),
      dayOpen: candles[0]?.open ?? null,
      prevHigh, prevLow,
      prevCandleHigh: candles[i - 1]?.high ?? null,
      prevCandleLow: candles[i - 1]?.low ?? null,
    };
    const currentMetrics = computeAllMetrics(metricNames, ctx);
    // In latestOnly mode there's no scan history to draw a "previous" value
    // from for crossover detection, so compute it fresh from the candle
    // just before this one - a single-step comparison, not a multi-candle walk.
    const previousForCompare = latestOnly
      ? computeAllMetrics(metricNames, { closes: candles.slice(0, i).map((c) => c.close), candles: candles.slice(0, i), vwapVal: vwap(candles.slice(0, i)), dayOpen: candles[0]?.open ?? null, prevHigh, prevLow, prevCandleHigh: candles[i - 2]?.high ?? null, prevCandleLow: candles[i - 2]?.low ?? null })
      : (prevMetrics || {});
    const allMet = entryConditions.every((c) => evaluateCondition(c, currentMetrics, previousForCompare));
    if (allMet) return { price: candles[i].close, time: candles[i].time, metrics: currentMetrics };
    prevMetrics = currentMetrics;
  }
  return null;
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

  const { data: strategies } = await supabaseAdmin.from("strategies").select("*").eq("active", true);
  if (!strategies?.length) return NextResponse.json({ ran: 0 });

  const userIds = Array.from(new Set(strategies.map((s) => s.user_id)));
  const { data: connections } = await supabaseAdmin.from("broker_connections").select("*").in("user_id", userIds);
  const connByUser = Object.fromEntries((connections || []).map((c) => [c.user_id, c]));
  const { data: deltaConns } = await supabaseAdmin.from("delta_connections").select("*").in("user_id", userIds);
  const deltaConnByUser = Object.fromEntries((deltaConns || []).map((c) => [c.user_id, c]));

  for (const s of strategies) {
    const usesDelta = isDelta(s.instrument_key);
    // NSE instruments don't trade on weekends; crypto on Delta trades 24/7.
    if (!usesDelta && (day === 0 || day === 6)) { results.push({ strategy: s.id, skipped: "weekend" }); continue; }

    const conn = connByUser[s.user_id];
    if (!usesDelta && !conn?.access_token) { results.push({ strategy: s.id, skipped: "no broker connection" }); continue; }
    if (!s.entry_conditions?.length) { results.push({ strategy: s.id, skipped: "no conditions defined" }); continue; }

    const startMin = timeStrToMinutes(s.window_start);
    const endMin = timeStrToMinutes(s.window_end);

    const { data: openTradeRows } = await supabaseAdmin.from("paper_trades").select("*")
      .in("status", ["open", "pending_confirmation"]).eq("strategy_id", s.id).eq("trade_date", today)
      .order("entry_time", { ascending: false }).limit(1);
    const openTrade = openTradeRows?.[0] || null;

    // Nagging for an unconfirmed live trade happens regardless of market hours or window.
    if (openTrade?.status === "pending_confirmation") {
      const lastNag = openTrade.last_nag_sent_at ? new Date(openTrade.last_nag_sent_at) : null;
      const minutesSince = lastNag ? (new Date() - lastNag) / 60000 : Infinity;
      if (minutesSince >= NAG_INTERVAL_MINUTES) {
        await supabaseAdmin.from("paper_trades").update({ last_nag_sent_at: new Date().toISOString() }).eq("id", openTrade.id);
        await notifyHit(s, openTrade, true);
        results.push({ strategy: s.id, action: "nagged_again" });
      } else {
        results.push({ strategy: s.id, action: "waiting_for_confirmation" });
      }
      continue;
    }

    if (nowMinutes >= endMin) {
      if (openTrade && openTrade.status === "open") {
        if (openTrade.real_order) {
          // Don't guess at this - check the actual exchange position before
          // deciding anything. Never silently mark a real order "closed" when
          // Delta might still have it open with an active bracket order.
          const dConn = deltaConnByUser[s.user_id];
          if (dConn?.encrypted_api_key) {
            try {
              const apiKey = decrypt(dConn.encrypted_api_key);
              const apiSecret = decrypt(dConn.encrypted_api_secret);
              const posRes = await deltaGetPosition(dConn.environment, apiKey, apiSecret, openTrade.delta_product_id);
              const pos = Array.isArray(posRes.result) ? posRes.result[0] : posRes.result;
              const stillOpen = pos && Number(pos.size) !== 0;
              if (!stillOpen) {
                const ltp = await fetchLtp(s.instrument_key, null);
                const qty = openTrade.qty || 1;
                const contractValue = openTrade.contract_value || 1;
                let pnl = null, grossPnl = null, fees = null;
                if (ltp) {
                  grossPnl = (s.direction === "long" ? ltp - openTrade.entry_price : openTrade.entry_price - ltp) * qty * contractValue;
                  const entryNotional = openTrade.entry_price * qty * contractValue;
                  const exitNotional = ltp * qty * contractValue;
                  const feeCalc = calculateRoundTripFees("delta", entryNotional, exitNotional);
                  fees = feeCalc?.totalCost ?? 0;
                  pnl = grossPnl - fees;
                }
                await supabaseAdmin.from("paper_trades").update({
                  status: "closed", exit_price: ltp, exit_time: new Date().toISOString(), pnl, gross_pnl: grossPnl, fees,
                  notes: "Real order - exit price is estimated. Verify actual result in your Delta Exchange account.",
                }).eq("id", openTrade.id);
                results.push({ strategy: s.id, action: "real_position_closed_at_window_end", pnl });
              } else {
                results.push({ strategy: s.id, action: "real_position_still_open_past_window_end" });
              }
            } catch (e) {
              console.error("window-end delta position check failed:", e);
              results.push({ strategy: s.id, skipped: "window-end delta position check error" });
            }
          }
          continue;
        }
        const ltp = await fetchLtp(s.instrument_key, conn?.access_token);
        if (ltp) {
          const qty = openTrade.qty || s.qty || 1;
          const pnl = s.direction === "long" ? (ltp - openTrade.entry_price) * qty : (openTrade.entry_price - ltp) * qty;
          if (openTrade.is_live) {
            await supabaseAdmin.from("paper_trades").update({
              status: "pending_confirmation", exit_price: ltp, exit_time: new Date().toISOString(),
              pnl, hit_type: "window_end", last_nag_sent_at: new Date().toISOString(),
            }).eq("id", openTrade.id);
            await notifyHit(s, { ...openTrade, exit_price: ltp, pnl, hit_type: "window_end" }, false);
            results.push({ strategy: s.id, action: "live_window_end_pending_confirmation" });
          } else {
            await supabaseAdmin.from("paper_trades").update({ status: "closed", exit_price: ltp, exit_time: new Date().toISOString(), pnl }).eq("id", openTrade.id);
            results.push({ strategy: s.id, action: "force_closed_eod", pnl });
          }
        }
      }
      continue;
    }
    if (nowMinutes < startMin) { results.push({ strategy: s.id, skipped: "before window" }); continue; }

    if (openTrade) {
      // Real order on Delta - the exchange's own bracket order manages the exit.
      // We just poll to see if it's closed yet, we don't recompute stop/target ourselves.
      if (openTrade.real_order) {
        const dConn = deltaConnByUser[s.user_id];
        if (!dConn?.encrypted_api_key) { results.push({ strategy: s.id, skipped: "no delta connection" }); continue; }
        try {
          const apiKey = decrypt(dConn.encrypted_api_key);
          const apiSecret = decrypt(dConn.encrypted_api_secret);
          const posRes = await deltaGetPosition(dConn.environment, apiKey, apiSecret, openTrade.delta_product_id);
          const pos = Array.isArray(posRes.result) ? posRes.result[0] : posRes.result;
          const stillOpen = pos && Number(pos.size) !== 0;
          if (!stillOpen) {
            // Position closed on the exchange (stop or target hit there). Estimate
            // exit/PNL from current price for display - the real number of record
            // is always what Delta itself shows in your account.
            const ltp = await fetchLtp(s.instrument_key, null);
            const qty = openTrade.qty || 1;
            const contractValue = openTrade.contract_value || 1;
            let pnl = null, grossPnl = null, fees = null;
            if (ltp) {
              grossPnl = (s.direction === "long" ? ltp - openTrade.entry_price : openTrade.entry_price - ltp) * qty * contractValue;
              const entryNotional = openTrade.entry_price * qty * contractValue;
              const exitNotional = ltp * qty * contractValue;
              const feeCalc = calculateRoundTripFees("delta", entryNotional, exitNotional);
              fees = feeCalc?.totalCost ?? 0;
              pnl = grossPnl - fees;
            }
            await supabaseAdmin.from("paper_trades").update({
              status: "closed", exit_price: ltp, exit_time: new Date().toISOString(), pnl, gross_pnl: grossPnl, fees,
              notes: "Real order - exit price is estimated. Verify actual result in your Delta Exchange account.",
            }).eq("id", openTrade.id);
            results.push({ strategy: s.id, action: "real_position_closed", estimatedPnl: pnl });
          } else {
            if (openTrade.position_check_failures > 0) {
              await supabaseAdmin.from("paper_trades").update({ position_check_failures: 0 }).eq("id", openTrade.id);
            }
            results.push({ strategy: s.id, action: "real_position_open" });
          }
        } catch (e) {
          console.error("delta position check failed:", e);
          const failures = (openTrade.position_check_failures || 0) + 1;
          await supabaseAdmin.from("paper_trades").update({ position_check_failures: failures }).eq("id", openTrade.id);
          if (failures === 3) {
            // Repeated failures, not a one-off blip - tell the user rather than silently going stale.
            try {
              const { data: userData } = await supabaseAdmin.auth.admin.getUserById(s.user_id);
              if (userData?.user?.email) {
                await sendEmail({
                  to: userData.user.email,
                  subject: `⚠️ Can't verify status of a real trade on "${s.name}"`,
                  html: `<p>We've failed to check whether your live position on <b>${s.name}</b> (${s.instrument_key}) is still open, ${failures} times in a row.</p>
                         <p>This trade might already be closed on Delta and we just can't confirm it, or something's wrong with the connection. <b>Please check your Delta Exchange account directly</b> and use "Close (cleanup)" on this trade in the app if it's actually already closed.</p>`,
                });
              }
            } catch (emailErr) { console.error("failure alert email failed:", emailErr); }
          }
          results.push({ strategy: s.id, skipped: "delta position check error", failures });
        }
        continue;
      }

      const ltp = await fetchLtp(s.instrument_key, conn?.access_token);
      if (!ltp) { results.push({ strategy: s.id, skipped: "no ltp" }); continue; }
      let hit = false, hitType = null, hitPrice = ltp;

      if (openTrade.stop_price != null && openTrade.target_price != null) {
        // Prefer scanning candles since entry - catches a touch that reversed between checks.
        try {
          const scan = await scanForTouchSinceEntry(s.instrument_key, conn?.access_token, openTrade.entry_time, openTrade.stop_price, openTrade.target_price, s.direction);
          if (scan.hit) { hit = true; hitType = scan.hitType; hitPrice = scan.price; }
        } catch (e) {
          console.error("touch scan failed, falling back to LTP check:", e);
        }
        if (!hit) {
          const stopHit = s.direction === "long" ? ltp <= openTrade.stop_price : ltp >= openTrade.stop_price;
          const targetHit = s.direction === "long" ? ltp >= openTrade.target_price : ltp <= openTrade.target_price;
          hit = stopHit || targetHit;
          hitType = stopHit ? "stop" : targetHit ? "target" : null;
          hitPrice = ltp;
        }
      } else {
        const moveFavorable = s.direction === "long" ? ltp - openTrade.entry_price : openTrade.entry_price - ltp;
        const movePct = (moveFavorable / openTrade.entry_price) * 100;
        hit = movePct <= -Math.abs(s.stop_loss_pct || 0.5) || movePct >= Math.abs(s.target_pct || 1);
        hitType = movePct <= -Math.abs(s.stop_loss_pct || 0.5) ? "stop" : "target";
        hitPrice = ltp;
      }

      if (hit) {
        const qty = openTrade.qty || s.qty || 1;
        const pnl = (s.direction === "long" ? hitPrice - openTrade.entry_price : openTrade.entry_price - hitPrice) * qty;

        if (openTrade.is_live) {
          // Real money is on the line here - don't silently close it. Make them confirm.
          await supabaseAdmin.from("paper_trades").update({
            status: "pending_confirmation", exit_price: hitPrice, exit_time: new Date().toISOString(),
            pnl, hit_type: hitType, last_nag_sent_at: new Date().toISOString(),
          }).eq("id", openTrade.id);
          await notifyHit(s, { ...openTrade, exit_price: hitPrice, pnl, hit_type: hitType }, false);
          results.push({ strategy: s.id, action: "live_hit_pending_confirmation", hitType, pnl });
        } else {
          await supabaseAdmin.from("paper_trades").update({ status: "closed", exit_price: hitPrice, exit_time: new Date().toISOString(), pnl }).eq("id", openTrade.id);
          results.push({ strategy: s.id, action: "closed", pnl });
        }
      } else {
        results.push({ strategy: s.id, action: "holding" });
      }
      continue;
    }

    const candles = await fetchIntradayCandles(s.instrument_key, conn?.access_token, s.timeframe || "5m");
    if (candles.length < 2) { results.push({ strategy: s.id, skipped: "not enough candle data yet" }); continue; }
    const prevLevels = await fetchPrevDayLevels(s.instrument_key, conn?.access_token);

    // Only look for a NEW signal after the last trade closed today - otherwise
    // an old candle that's still technically true (common in a choppy range)
    // gets re-discovered and re-traded again and again.
    const { data: lastClosed } = await supabaseAdmin.from("paper_trades").select("exit_time")
      .eq("strategy_id", s.id).eq("trade_date", today).eq("status", "closed")
      .order("exit_time", { ascending: false }).limit(1);
    const afterMs = lastClosed?.[0]?.exit_time ? new Date(lastClosed[0].exit_time).getTime() : null;

    const scanResult = scanCandlesForEntry(candles, s.entry_conditions, prevLevels?.high ?? null, prevLevels?.low ?? null, startMin, endMin, s.stop_loss_type === "candle_metric" ? s.stop_loss_metric : null, afterMs, s.entry_scan_mode === "latest_only");

    const allMet = !!scanResult;
    const currentMetrics = scanResult?.metrics || {};

    if (allMet) {
      const candleClosePrice = scanResult.price;
      // Use a fresh live price at the moment of entry instead of the (possibly
      // several-minutes-stale) candle close used to evaluate the conditions.
      const freshLtp = await fetchLtp(s.instrument_key, conn?.access_token);
      const entryPrice = freshLtp ?? candleClosePrice;

      // Anti-chase guard: if price has already moved too far from where the
      // condition was actually evaluated, skip this cycle rather than enter
      // at a materially worse price than the signal intended. Default: 0.15%.
      const maxSlippagePct = s.max_slippage_pct ?? 0.15;
      const driftPct = Math.abs((entryPrice - candleClosePrice) / candleClosePrice) * 100;
      if (driftPct > maxSlippagePct) {
        results.push({ strategy: s.id, action: "skipped_price_moved_too_far", candleClosePrice, freshLtp, driftPct });
        continue;
      }

      let stopPrice;
      if (s.stop_loss_type === "candle_metric" && s.stop_loss_metric) {
        stopPrice = currentMetrics[s.stop_loss_metric];
      } else {
        const pct = s.stop_loss_value ?? s.stop_loss_pct ?? 0.5;
        stopPrice = s.direction === "long" ? entryPrice * (1 - pct / 100) : entryPrice * (1 + pct / 100);
      }
      if (stopPrice == null) { results.push({ strategy: s.id, skipped: "stop-loss reference metric unavailable" }); continue; }

      const riskPoints = Math.abs(entryPrice - stopPrice);
      if (s.max_risk_points && riskPoints > s.max_risk_points) {
        results.push({ strategy: s.id, action: "skipped_risk_too_large", riskPoints });
        continue;
      }
      if (s.min_risk_points && riskPoints < s.min_risk_points) {
        results.push({ strategy: s.id, action: "skipped_risk_too_small", riskPoints });
        continue;
      }

      let targetPrice;
      if (s.target_type === "r_multiple") {
        const multiple = s.target_value ?? 5;
        targetPrice = s.direction === "long" ? entryPrice + riskPoints * multiple : entryPrice - riskPoints * multiple;
      } else {
        const pct = s.target_value ?? s.target_pct ?? 1;
        targetPrice = s.direction === "long" ? entryPrice * (1 + pct / 100) : entryPrice * (1 - pct / 100);
      }

      // Position sizing: either a fixed quantity, or auto-calculated from
      // how much capital the user is willing to risk vs. the stop distance.
      let qty = s.qty || 1;
      if (s.position_sizing_mode === "risk_based" && s.capital_base && s.risk_pct && riskPoints > 0) {
        const lot = s.lot_size || 1;
        const rawQty = (s.capital_base * (s.risk_pct / 100)) / riskPoints;
        qty = Math.floor(rawQty / lot) * lot;
        if (qty <= 0) {
          results.push({ strategy: s.id, action: "skipped_risk_too_small", riskPoints, rawQty });
          continue;
        }
      }

      if (s.execution_mode === "delta_live") {
        const dConn = deltaConnByUser[s.user_id];
        if (!dConn?.encrypted_api_key) { results.push({ strategy: s.id, skipped: "delta not connected - entry not taken" }); continue; }
        try {
          const apiKey = decrypt(dConn.encrypted_api_key);
          const apiSecret = decrypt(dConn.encrypted_api_secret);
          const symbol = deltaSymbol(s.instrument_key);
          const product = await deltaGetProduct(dConn.environment, symbol);
          if (!product) { results.push({ strategy: s.id, skipped: "could not fetch delta product info" }); continue; }

          const contractValue = parseFloat(product.contract_value);
          // "fixed_lots" means qty IS the number of Delta contracts directly -
          // matches how Delta's own trading screen works, no underlying-asset
          // conversion involved. Every other mode converts qty (in underlying
          // asset units) into contracts via the contract size.
          let contracts = s.position_sizing_mode === "fixed_lots" ? Math.round(qty) : Math.round(qty / contractValue);

          // Hard cap: never exceed the configured max position size in USD, no matter what the sizing math says.
          if (s.max_position_usd) {
            const notional = contracts * contractValue * entryPrice;
            if (notional > s.max_position_usd) {
              contracts = Math.floor(s.max_position_usd / (contractValue * entryPrice));
            }
          }
          if (contracts < 1) { results.push({ strategy: s.id, skipped: "position size rounds to zero contracts" }); continue; }

          // Reserve this strategy's slot for today BEFORE placing any real order.
          // If this fails, another overlapping run already claimed it - stop
          // here, no real order gets placed at all.
          const { data: reservation, error: reserveErr } = await supabaseAdmin.from("paper_trades").insert({
            strategy_id: s.id, user_id: s.user_id, instrument_key: s.instrument_key,
            side: s.direction === "long" ? "buy" : "sell", entry_price: entryPrice,
            entry_time: new Date().toISOString(), status: "open", trade_date: today,
            stop_price: stopPrice, target_price: targetPrice, risk_points: riskPoints, qty,
            real_order: true, contract_value: contractValue,
          }).select().single();
          if (reserveErr) {
            results.push({ strategy: s.id, action: "entry_skipped_already_open", detail: reserveErr.message });
            continue;
          }

          await deltaSetLeverage(dConn.environment, apiKey, apiSecret, product.id, s.leverage || 25);
          const orderRes = await deltaPlaceBracketEntry(dConn.environment, apiKey, apiSecret, {
            productId: product.id,
            side: s.direction === "long" ? "buy" : "sell",
            size: contracts,
            stopLossPrice: stopPrice,
            takeProfitPrice: targetPrice,
          });

          if (!orderRes.success) {
            // The real order failed - release the reservation, no trade actually happened.
            await supabaseAdmin.from("paper_trades").delete().eq("id", reservation.id);
            results.push({ strategy: s.id, action: "delta_order_failed", error: orderRes.error });
            continue;
          }

          const filledPrice = parseFloat(orderRes.result.limit_price || entryPrice);
          await supabaseAdmin.from("paper_trades").update({
            entry_price: filledPrice,
            delta_order_id: String(orderRes.result.id), delta_product_id: product.id,
          }).eq("id", reservation.id);
          results.push({ strategy: s.id, action: "real_order_placed", contracts, price: filledPrice });

          try {
            const { data: userData } = await supabaseAdmin.auth.admin.getUserById(s.user_id);
            const email = userData?.user?.email;
            if (email) {
              await sendEmail({
                to: email,
                subject: `🔴 REAL order placed: "${s.name}" (${dConn.environment})`,
                html: `<p><b>${s.name}</b> just placed a REAL ${dConn.environment} order on Delta Exchange.</p>
                       <p>Instrument: ${s.instrument_key}<br/>Side: ${s.direction}<br/>Size: ${contracts} contracts<br/>
                       Entry: ${filledPrice}<br/>Stop: ${stopPrice}<br/>Target: ${targetPrice}<br/>Leverage: ${s.leverage || 25}x</p>
                       <p style="color:#c00;">This used real funds${dConn.environment === "testnet" ? " (testnet - not real money)" : ""}. Verify in your Delta Exchange account.</p>`,
              });
            }
          } catch (e) { console.error("live order email failed:", e); }
        } catch (e) {
          console.error("delta live entry failed:", e);
          results.push({ strategy: s.id, action: "delta_entry_error", error: String(e) });
        }
        continue;
      }

      const { error: insertErr } = await supabaseAdmin.from("paper_trades").insert({
        strategy_id: s.id, user_id: s.user_id, instrument_key: s.instrument_key,
        side: s.direction === "long" ? "buy" : "sell", entry_price: entryPrice,
        entry_time: new Date().toISOString(), status: "open", trade_date: today,
        stop_price: stopPrice, target_price: targetPrice, risk_points: riskPoints, qty,
      });
      if (insertErr) {
        // Another overlapping run already opened a trade for this strategy today - not an error, just a race we lost gracefully.
        results.push({ strategy: s.id, action: "entry_skipped_already_open", detail: insertErr.message });
        continue;
      }
      results.push({ strategy: s.id, action: "entered", price: entryPrice, stopPrice, targetPrice, qty });

      // Fire an email alert - best-effort, never blocks the main loop.
      try {
        const { data: userData } = await supabaseAdmin.auth.admin.getUserById(s.user_id);
        const email = userData?.user?.email;
        if (email) {
          await sendEmail({
            to: email,
            subject: `Traider: "${s.name}" entry triggered`,
            html: `<p><b>${s.name}</b> just triggered a paper entry.</p>
                   <p>Instrument: ${s.instrument_key}<br/>
                   Direction: ${s.direction}<br/>
                   Entry: ${entryPrice}<br/>
                   Stop: ${stopPrice}<br/>
                   Target: ${targetPrice}<br/>
                   Quantity: ${qty}</p>
                   <p style="color:#888;font-size:12px;">This is a simulated paper trade. No real order was placed.</p>`,
          });
        }
      } catch (e) {
        console.error("email alert failed:", e);
      }
    } else {
      results.push({ strategy: s.id, action: "waiting", metrics: currentMetrics });
    }
  }

  return NextResponse.json({ ran: strategies.length, results });
}

async function notifyHit(strategy, trade, isRepeat) {
  try {
    const { data: userData } = await supabaseAdmin.auth.admin.getUserById(strategy.user_id);
    const email = userData?.user?.email;
    if (!email) return;
    const hitLabel = trade.hit_type === "target" ? "hit your target" : trade.hit_type === "window_end" ? "reached the end of its trading window" : "hit your stop-loss";
    await sendEmail({
      to: email,
      subject: isRepeat
        ? `⚠️ STILL WAITING: confirm "${strategy.name}" is squared off`
        : `🚨 "${strategy.name}" ${hitLabel} — square off and confirm now`,
      html: `<p style="font-size:16px;"><b>${strategy.name}</b> (${strategy.instrument_key}) ${hitLabel}.</p>
             <p>Entry: ${trade.entry_price}<br/>Exit level: ${trade.exit_price}<br/>Estimated P&L: ${trade.pnl != null ? trade.pnl.toFixed(2) : "—"}</p>
             <p><b>Square off the real position on your broker right now</b>, then open Traider's Auto tab and upload a screenshot to confirm.</p>
             <p style="color:#c00;">You'll keep receiving this email every ${NAG_INTERVAL_MINUTES} minutes until you confirm.</p>`,
    });
  } catch (e) {
    console.error("live trade notify failed:", e);
  }
}
