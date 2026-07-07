import { createClient } from "@supabase/supabase-js";

// This uses the PUBLIC (publishable/anon) key on purpose - it's safe in the
// browser because every table has Row Level Security turned on, so a user
// can only ever read/write their own rows.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);
