import { createClient } from "@supabase/supabase-js";

// SERVER ONLY. This uses the SECRET key, which bypasses Row Level Security.
// Never import this file into anything that runs in the browser.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Builds a Supabase client that acts AS a specific logged-in user (respects
// RLS), given the access token their browser sent us. Used in API routes
// that should only ever touch that one user's rows.
export function supabaseAsUser(accessToken) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  );
}
