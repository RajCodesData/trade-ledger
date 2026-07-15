-- Run this in Supabase SQL Editor (New query -> paste -> Run)
-- Adds the classification needed to split P&L into the right tax buckets:
-- equity_intraday -> speculative business income
-- futures / options -> non-speculative business income (F&O)
-- equity_delivery  -> capital gains (STCG/LTCG based on holding period)

alter table trades
  add column if not exists segment text not null default 'equity_intraday'
  check (segment in ('equity_intraday','equity_delivery','futures','options'));

-- Needed to tell short-term vs long-term capital gains apart for delivery trades.
-- For intraday/F&O trades this can just equal entry_time.
alter table trades
  add column if not exists exit_time timestamptz;
