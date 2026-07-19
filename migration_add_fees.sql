-- Keeps pnl as the NET result (what actually happens to your account balance),
-- while preserving the raw price-based number and fee breakdown separately
-- so you can always see both.
alter table paper_trades add column if not exists gross_pnl numeric;
alter table paper_trades add column if not exists fees numeric;
