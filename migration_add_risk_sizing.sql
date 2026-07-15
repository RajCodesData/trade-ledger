-- Run in Supabase SQL Editor after the earlier migrations

alter table strategies add column if not exists position_sizing_mode text not null default 'fixed_qty'
  check (position_sizing_mode in ('fixed_qty','risk_based'));
alter table strategies add column if not exists capital_base numeric;   -- total capital this strategy is sized against
alter table strategies add column if not exists risk_pct numeric;       -- % of capital to risk per trade
alter table strategies add column if not exists lot_size numeric not null default 1; -- round position size down to a multiple of this

-- Each paper trade needs its own qty stored, since risk-based sizing means
-- quantity can differ trade to trade even within the same strategy.
alter table paper_trades add column if not exists qty numeric;
