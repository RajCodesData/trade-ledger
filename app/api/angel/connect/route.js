import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { encrypt } from "../../../../lib/crypto";
import { angelLogin } from "../../../../lib/angelOne";

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { apiKey, clientCode, pin, totpSecret } = await request.json();
  if (!apiKey || !clientCode || !pin || !totpSecret) {
    return NextResponse.json({ error: "API key, client code, PIN, and TOTP secret are all required." }, { status: 400 });
  }

  try {
    const loginRes = await angelLogin(apiKey.trim(), clientCode.trim(), pin.trim(), totpSecret.trim());
    if (!loginRes.status || !loginRes.data?.jwtToken) {
      return NextResponse.json({ error: `Angel One rejected these credentials: ${loginRes.message || loginRes.errorcode || "unknown error"}. Double check your client code, PIN, and that the TOTP secret is the raw manual-entry key, not a 6-digit code.` }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("angel_connections").upsert({
      user_id: userData.user.id,
      encrypted_api_key: encrypt(apiKey.trim()),
      encrypted_client_code: encrypt(clientCode.trim()),
      encrypted_pin: encrypt(pin.trim()),
      encrypted_totp_secret: encrypt(totpSecret.trim()),
      jwt_token: loginRes.data.jwtToken,
      refresh_token: loginRes.data.refreshToken,
      feed_token: loginRes.data.feedToken,
      session_expires_at: new Date(new Date().setHours(23, 59, 0, 0)).toISOString(), // sessions expire at midnight
      connected_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true, verified: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to verify or save connection. Check ENCRYPTION_KEY is set correctly in Vercel." }, { status: 500 });
  }
}
