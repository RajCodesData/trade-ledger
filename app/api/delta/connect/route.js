import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { encrypt } from "../../../../lib/crypto";
import { deltaVerifyCredentials } from "../../../../lib/deltaExchange";

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { apiKey, apiSecret, environment } = await request.json();
  if (!apiKey || !apiSecret) return NextResponse.json({ error: "API key and secret are required." }, { status: 400 });
  const env = environment === "production" ? "production" : "testnet";

  try {
    const verify = await deltaVerifyCredentials(env, apiKey.trim(), apiSecret.trim());
    if (!verify.success) {
      const code = verify.error?.code || "unknown_error";
      const detail = verify.error?.message ? ` (${verify.error.message})` : "";
      return NextResponse.json({ error: `Delta rejected these credentials: ${code}${detail}. Double check the key/secret, the environment (testnet vs production), and that "Read Data" permission is enabled.` }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("delta_connections").upsert({
      user_id: userData.user.id,
      environment: env,
      encrypted_api_key: encrypt(apiKey.trim()),
      encrypted_api_secret: encrypt(apiSecret.trim()),
      connected_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Safety: never let a strategy that was armed against one environment
    // (e.g. testnet) silently keep running after the connection switches to
    // another environment (e.g. production). Force a conscious re-arm.
    const { data: disarmed, error: disarmErr } = await supabaseAdmin.from("strategies")
      .update({ active: false })
      .eq("user_id", userData.user.id)
      .eq("execution_mode", "delta_live")
      .eq("active", true)
      .select();

    if (disarmErr) console.error("Failed to disarm live strategies:", disarmErr);

    return NextResponse.json({ success: true, verified: true, environment: env, disarmedCount: disarmed?.length || 0 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to save connection. Check ENCRYPTION_KEY is set correctly in Vercel." }, { status: 500 });
  }
}
