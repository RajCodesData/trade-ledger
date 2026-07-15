import crypto from "crypto";

function baseUrl(env) {
  return env === "testnet" ? "https://cdn-ind.testnet.deltaex.org" : "https://api.india.delta.exchange";
}

function sign(secret, method, timestamp, path, queryString, body) {
  const message = method + timestamp + path + queryString + body;
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// Public endpoints (no auth needed) - ticker price and historical candles.
// Always use production for market data since it reflects real prices,
// even when the trading side is pointed at testnet.
export async function deltaGetTicker(symbol) {
  const res = await fetch(`${baseUrl("production")}/v2/tickers/${symbol}`, { headers: { Accept: "application/json" } });
  const data = await res.json();
  if (!data.success) return null;
  return parseFloat(data.result.mark_price);
}

export async function deltaGetCandles(symbol, resolution, startUnix, endUnix) {
  const url = `${baseUrl("production")}/v2/history/candles?symbol=${symbol}&resolution=${resolution}&start=${startUnix}&end=${endUnix}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await res.json();
  if (!data.success || !Array.isArray(data.result)) return [];
  // Delta returns newest-first; normalize to oldest-first like the rest of the engine expects.
  return data.result
    .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => a.time - b.time);
}

// ---- authenticated trading functions (used only for real order placement) ----

async function deltaRequest(env, apiKey, apiSecret, method, path, queryString = "", bodyObj = null) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const signature = sign(apiSecret, method, timestamp, path, queryString, body);
  const res = await fetch(`${baseUrl(env)}${path}${queryString}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": apiKey,
      signature,
      timestamp,
      "User-Agent": "tradeledger-nextjs",
    },
    body: body || undefined,
  });
  return res.json();
}

export async function deltaGetProduct(env, symbol) {
  const res = await fetch(`${baseUrl(env)}/v2/products/${symbol}`, { headers: { Accept: "application/json" } });
  const data = await res.json();
  if (!data.success) return null;
  return data.result; // includes id (product_id) and contract_value
}

export async function deltaSetLeverage(env, apiKey, apiSecret, productId, leverage) {
  return deltaRequest(env, apiKey, apiSecret, "POST", `/v2/products/${productId}/orders/leverage`, "", { leverage: String(leverage) });
}

// Places a market order with exchange-managed stop-loss and take-profit attached
// (a "bracket" order) so the exchange itself executes the exit, not our polling loop.
export async function deltaPlaceBracketEntry(env, apiKey, apiSecret, { productId, side, size, stopLossPrice, takeProfitPrice }) {
  return deltaRequest(env, apiKey, apiSecret, "POST", "/v2/orders", "", {
    product_id: productId,
    size,
    side,
    order_type: "market_order",
    bracket_stop_loss_price: String(stopLossPrice),
    bracket_take_profit_price: String(takeProfitPrice),
    bracket_stop_trigger_method: "last_traded_price",
  });
}

export async function deltaGetPosition(env, apiKey, apiSecret, productId) {
  return deltaRequest(env, apiKey, apiSecret, "GET", "/v2/positions", `?product_id=${productId}`);
}
