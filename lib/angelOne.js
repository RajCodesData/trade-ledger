import crypto from "crypto";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const BASE_URL = "https://apiconnect.angelone.in";

// ---- TOTP (RFC 6238) generation from a base32 secret - no external dependency needed ----
function base32Decode(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return Buffer.from(bytes);
}

export function generateTOTP(base32Secret) {
  const key = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, "0");
}

// ---- Request helper - routes through QuotaGuard when available, since order
// placement requires a static, pre-whitelisted IP (same requirement Delta has) ----
async function angelRequest(method, path, body, extraHeaders = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    ...extraHeaders,
  };
  const url = `${BASE_URL}${path}`;
  const options = { method, headers, body: body ? JSON.stringify(body) : undefined };

  if (process.env.QUOTAGUARD_URL) {
    const dispatcher = new ProxyAgent(process.env.QUOTAGUARD_URL.trim());
    const res = await undiciFetch(url, { ...options, dispatcher });
    return res.json();
  }
  const res = await fetch(url, options);
  return res.json();
}

// Logs in fresh using client code + PIN + TOTP secret. Returns jwtToken,
// refreshToken, feedToken - used both to verify a new connection and to
// generate a daily session automatically without any manual reconnect step.
export async function angelLogin(apiKey, clientCode, pin, totpSecret) {
  const totp = generateTOTP(totpSecret);
  return angelRequest("POST", "/rest/auth/angelbroking/user/v1/loginByPassword",
    { clientcode: clientCode, password: pin, totp },
    { "X-PrivateKey": apiKey }
  );
}

export async function angelRefreshSession(apiKey, refreshToken) {
  return angelRequest("POST", "/rest/auth/angelbroking/jwt/v1/generateTokens",
    { refreshToken },
    { "X-PrivateKey": apiKey }
  );
}

export async function angelGetProfile(apiKey, jwtToken) {
  return angelRequest("GET", "/rest/secure/angelbroking/user/v1/getProfile", null,
    { "X-PrivateKey": apiKey, Authorization: `Bearer ${jwtToken}` }
  );
}

// Returns a valid { jwtToken, refreshToken, feedToken, refreshed } for placing
// orders. Tries the cached token first, then a silent refresh, and only falls
// back to a fresh TOTP login if both are unavailable/expired - this is what
// lets Angel One auto-renew daily without the manual reconnect Upstox needs.
export async function angelEnsureSession({ apiKey, clientCode, pin, totpSecret, jwtToken, refreshToken, sessionExpiresAt }) {
  const stillValid = jwtToken && sessionExpiresAt && new Date(sessionExpiresAt).getTime() > Date.now() + 60000;
  if (stillValid) return { jwtToken, refreshToken, feedToken: null, refreshed: false };

  if (refreshToken) {
    try {
      const r = await angelRefreshSession(apiKey, refreshToken);
      if (r.status && r.data?.jwtToken) {
        return { jwtToken: r.data.jwtToken, refreshToken: r.data.refreshToken || refreshToken, feedToken: r.data.feedToken || null, refreshed: true };
      }
    } catch (e) {
      console.error("angel silent refresh failed, falling back to fresh login:", e);
    }
  }

  const loginRes = await angelLogin(apiKey, clientCode, pin, totpSecret);
  if (!loginRes.status || !loginRes.data?.jwtToken) {
    throw new Error(`Angel One session refresh failed: ${loginRes.message || loginRes.errorcode || "unknown error"}`);
  }
  return { jwtToken: loginRes.data.jwtToken, refreshToken: loginRes.data.refreshToken, feedToken: loginRes.data.feedToken, refreshed: true };
}

// ---- instrument master (public, unauthenticated) - maps a human search like
// "RELIANCE" or "NIFTY" to the tradingsymbol/symboltoken pair Angel's order
// API actually requires. Cached in memory per warm lambda instance since this
// file changes rarely intraday and is tens of MB - refetching every call
// would be slow and wasteful. Cache resets on cold start, which is fine.
const SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
const SCRIP_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let scripMasterCache = { data: null, fetchedAt: 0 };

async function getScripMaster() {
  const age = Date.now() - scripMasterCache.fetchedAt;
  if (scripMasterCache.data && age < SCRIP_CACHE_TTL_MS) return scripMasterCache.data;
  const res = await fetch(SCRIP_MASTER_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Failed to fetch Angel One instrument master: HTTP ${res.status}`);
  const data = await res.json();
  scripMasterCache = { data, fetchedAt: Date.now() };
  return data;
}

// exchange filters exch_seg (e.g. "NSE" for equities/index spot, "NFO" for
// futures & options). Returns at most 25 matches - this is for interactive
// search-as-you-type, not bulk lookup.
export async function angelLookupSymbolToken(query, exchange = "NSE") {
  const master = await getScripMaster();
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const matches = master.filter((row) => row.exch_seg === exchange && row.symbol?.toUpperCase().includes(q));
  return matches.slice(0, 25).map((row) => ({
    tradingsymbol: row.symbol, symboltoken: row.token, name: row.name, lotsize: row.lotsize, exchange: row.exch_seg,
  }));
}

export async function angelGetLtp(apiKey, jwtToken, exchange, tradingsymbol, symboltoken) {
  const res = await angelRequest("POST", "/rest/secure/angelbroking/order/v1/getLtpData",
    { exchange, tradingsymbol, symboltoken },
    { "X-PrivateKey": apiKey, Authorization: `Bearer ${jwtToken}` }
  );
  if (!res.status || !res.data) return null;
  return parseFloat(res.data.ltp);
}

// Simple market order, INTRADAY (squared off same day), no bracket - Angel
// One has no reliable bracket-order API (the old BO product type is
// deprecated). Stop-loss/target are enforced by the engine itself polling
// and placing a real opposite-side order when hit, same mechanism as paper
// trades already use for touch detection.
export async function angelPlaceOrder(apiKey, jwtToken, { exchange, tradingsymbol, symboltoken, quantity, transactiontype }) {
  return angelRequest("POST", "/rest/secure/angelbroking/order/v1/placeOrder",
    {
      variety: "NORMAL",
      exchange,
      tradingsymbol,
      symboltoken,
      transactiontype, // "BUY" or "SELL"
      ordertype: "MARKET",
      producttype: "INTRADAY",
      duration: "DAY",
      quantity: String(quantity),
    },
    { "X-PrivateKey": apiKey, Authorization: `Bearer ${jwtToken}` }
  );
}
