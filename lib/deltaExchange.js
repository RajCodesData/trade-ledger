import crypto from "crypto";

const BASE_URL = "https://api.india.delta.exchange";

function sign(secret, method, timestamp, path, queryString, body) {
  const message = method + timestamp + path + queryString + body;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// Public endpoints (no auth needed) - ticker price and historical candles.
export async function deltaGetTicker(symbol) {
  const res = await fetch(`${BASE_URL}/v2/tickers/${symbol}`, { headers: { Accept: "application/json" } });
  const data = await res.json();
  if (!data.success) return null;
  return parseFloat(data.result.mark_price);
}

export async function deltaGetCandles(symbol, resolution, startUnix, endUnix) {
  const url = `${BASE_URL}/v2/history/candles?symbol=${symbol}&resolution=${resolution}&start=${startUnix}&end=${endUnix}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await res.json();
  if (!data.success || !Array.isArray(data.result)) return [];
  // Delta returns newest-first; normalize to oldest-first like the rest of the engine expects.
  return data.result
    .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => a.time - b.time);
}

// Authenticated GET, e.g. for balances/positions if needed later.
export async function deltaAuthedGet(apiKey, apiSecret, path, queryString = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(apiSecret, "GET", timestamp, path, queryString, "");
  const res = await fetch(`${BASE_URL}${path}${queryString}`, {
    headers: {
      Accept: "application/json",
      "api-key": apiKey,
      signature,
      timestamp,
      "User-Agent": "tradeledger-nextjs",
    },
  });
  return res.json();
}
