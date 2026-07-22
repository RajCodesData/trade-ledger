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
