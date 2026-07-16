-- Run in Supabase SQL Editor after the earlier migrations

-- Tracks fills that haven't been matched into a completed round-trip trade
-- yet - e.g. a BTST buy today with no sell today. Carried forward and
-- matched against future sync calls, whenever the exit actually happens.
create table if not exists open_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  instrument text not null,
  segment text not null,
  side text not null check (side in ('buy','sell')),
  remaining_qty numeric not null,
  avg_price numeric not null,
  opened_at timestamptz not null,
  updated_at timestamptz default now()
);
alter table open_positions enable row level security;
create policy "own open positions" on open_positions for all using (auth.uid() = user_id);

-- Tax-loss harvesting settings, stored on the profile.
alter table profiles add column if not exists annual_income numeric;
alter table profiles add column if not exists harvest_reminder_days numeric not null default 15;
alter table profiles add column if not exists last_harvest_email_sent date;
