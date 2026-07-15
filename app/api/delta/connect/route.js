import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { encrypt } from "../../../../lib/crypto";

export async function POST(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { apiKey, apiSecret, environment } = await request.json();
  if (!apiKey || !apiSecret) return NextResponse.json({ error: "API key and secret are required." }, { status: 400 });

  try {
    const { error } = await supabaseAdmin.from("delta_connections").upsert({
      user_id: userData.user.id,
      environment: environment === "production" ? "production" : "testnet",
      encrypted_api_key: encrypt(apiKey),
      encrypted_api_secret: encrypt(apiSecret),
      connected_at: new Date().toISOString(),
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to save connection. Check ENCRYPTION_KEY is set correctly." }, { status: 500 });
  }
}
