import { NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseAdmin";
import { angelLookupSymbolToken } from "../../../../lib/angelOne";

// Symbol search for the strategy builder UI. Auth-gated (not the credentials
// themselves - this hits Angel's public instrument master) mainly so it's
// not an open proxy anyone can hammer.
export async function GET(request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";
  const exchange = searchParams.get("exchange") || "NSE";
  if (query.trim().length < 2) return NextResponse.json({ matches: [] });

  try {
    const matches = await angelLookupSymbolToken(query, exchange);
    return NextResponse.json({ matches });
  } catch (e) {
    console.error("angel symbol lookup failed:", e);
    return NextResponse.json({ error: "Could not search Angel One's instrument list. Try again in a moment." }, { status: 500 });
  }
}
