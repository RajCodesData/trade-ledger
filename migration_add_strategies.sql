-- Run in Supabase SQL Editor after the earlier migrations

create table if not exists strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  name text not null,
  description text not null,
  instrument_key text not null,       -- e.g. "NSE_INDEX|Nifty 50"
  direction text not null check (direction in ('long','short')),
  entry_type text not null check (entry_type in (
    'breakout_above_prev_high','breakout_below_prev_low',
    'breakout_above_level','breakout_below_level'
  )),
  entry_level numeric,                -- only used for the *_level entry types
  window_start text not null default '09:15',
  window_end text not null default '15:15',
  stop_loss_pct numeric not null,
  target_pct numeric not null,
  qty numeric not null default 1,
  active boolean not null default false,
  reference_level numeric,            -- cached prev-day high/low for today
  reference_date date,                -- date the cache above was computed for
  created_at timestamptz default now()
);

create table if not exists paper_trades (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid references strategies on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  instrument_key text not null,
  side text not null,
  entry_price numeric not null,
  entry_time timestamptz not null,
  exit_price numeric,
  exit_time timestamptz,
  status text not null default 'open' check (status in ('open','closed')),
  pnl numeric,
  trade_date date not null default current_date
);

alter table strategies enable row level security;
alter table paper_trades enable row level security;

create policy "own strategies" on strategies for all using (auth.uid() = user_id);
create policy "own paper trades" on paper_trades for all using (auth.uid() = user_id);
