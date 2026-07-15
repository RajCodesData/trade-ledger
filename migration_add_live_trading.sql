-- Run in Supabase SQL Editor after all earlier migrations

-- Stores your Delta Exchange API credentials, encrypted at rest (see lib/crypto.js).
create table if not exists delta_connections (
  user_id uuid references auth.users on delete cascade primary key,
  environment text not null default 'testnet' check (environment in ('testnet','production')),
  encrypted_api_key text not null,
  encrypted_api_secret text not null,
  connected_at timestamptz default now()
);
alter table delta_connections enable row level security;
create policy "own delta connection" on delta_connections for all using (auth.uid() = user_id);

-- Strategy-level live trading controls. A strategy stays in "paper" mode
-- unless explicitly switched to "delta_live" - never live by default.
alter table strategies add column if not exists execution_mode text not null default 'paper'
  check (execution_mode in ('paper','delta_live'));
alter table strategies add column if not exists leverage numeric not null default 25;
alter table strategies add column if not exists max_position_usd numeric;

-- Tracks real order/position info for trades placed with real money.
alter table paper_trades add column if not exists real_order boolean not null default false;
alter table paper_trades add column if not exists delta_order_id text;
alter table paper_trades add column if not exists delta_product_id integer;
