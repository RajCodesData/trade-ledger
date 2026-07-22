-- Run in Supabase SQL Editor after all earlier migrations (including
-- whatever created angel_connections - if that table doesn't exist yet in
-- your database, create it first; see app/api/angel/connect/route.js for
-- the exact columns it writes).

-- Angel One instrument addressing on strategies. Fundamentally different
-- from Upstox's instrument_key or Delta's symbol - Angel's order API needs
-- an exact tradingsymbol + symboltoken pair, looked up from Angel's public
-- instrument master (see lib/angelOne.js: angelLookupSymbolToken).
-- instrument_key (Upstox) is still used for price/candle data to drive
-- entry/exit signals - Angel has no historical-candle API of its own wired
-- up yet. These columns only control where the REAL order gets placed.
alter table strategies add column if not exists angel_tradingsymbol text;
alter table strategies add column if not exists angel_symboltoken text;
alter table strategies add column if not exists angel_exchange text default 'NSE';

-- Allow the new "angel_live" execution mode alongside paper/delta_live.
-- A strategy stays in "paper" mode unless explicitly switched - never live by default.
alter table strategies drop constraint if exists strategies_execution_mode_check;
alter table strategies add constraint strategies_execution_mode_check
  check (execution_mode in ('paper', 'delta_live', 'angel_live'));

-- paper_trades.real_order alone no longer tells us which broker executed a
-- real order now that both Delta and Angel can produce real_order = true
-- rows - the engine needs to know which API to call for position checks and
-- exits. NULL/absent means "delta" for all pre-existing real Delta trades,
-- so no backfill is needed for old rows.
alter table paper_trades add column if not exists broker text;

-- Angel order IDs for entry and exit. Angel has no bracket order, so unlike
-- Delta, the exit is a second real order the engine places itself when it
-- detects a stop/target touch - both IDs are worth keeping for reconciling
-- against your Angel One order book if anything looks off.
alter table paper_trades add column if not exists angel_order_id text;
alter table paper_trades add column if not exists angel_exit_order_id text;
