import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const userId = searchParams.get("state"); // we passed the Supabase user id as `state`
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!code || !userId) {
    return NextResponse.redirect(`${appUrl}/?upstox=error`);
  }

  try {
    const tokenRes = await fetch("https://api.upstox.com/v2/login/authorization/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: process.env.NEXT_PUBLIC_UPSTOX_CLIENT_ID,
        client_secret: process.env.UPSTOX_API_SECRET,
        redirect_uri: process.env.NEXT_PUBLIC_UPSTOX_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Upstox token exchange failed:", tokenData);
      return NextResponse.redirect(`${appUrl}/?upstox=error`);
    }

    // Upstox tokens expire daily; store an approximate expiry 20 hours out.
    const expiresAt = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();

    await supabaseAdmin.from("broker_connections").upsert({
      user_id: userId,
      broker: "upstox",
      access_token: tokenData.access_token,
      connected_at: new Date().toISOString(),
      token_expires_at: expiresAt,
    });

    return NextResponse.redirect(`${appUrl}/?upstox=connected`);
  } catch (e) {
    console.error(e);
    return NextResponse.redirect(`${appUrl}/?upstox=error`);
  }
}
