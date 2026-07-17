-- Prevents the exact bug that caused runaway duplicate trades: enforces at
-- the database level that a strategy can only have ONE open/pending trade
-- per day, no matter how many overlapping cron runs try to insert one.
create unique index if not exists one_open_trade_per_strategy_per_day
  on paper_trades (strategy_id, trade_date)
  where status in ('open','pending_confirmation');
