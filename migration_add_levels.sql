-- Run in Supabase SQL Editor after the earlier migrations

alter table strategies add column if not exists stop_loss_type text not null default 'percent'
  check (stop_loss_type in ('percent','candle_metric'));
alter table strategies add column if not exists stop_loss_metric text; -- e.g. 'prev_candle_high', only used when stop_loss_type = 'candle_metric'
alter table strategies add column if not exists stop_loss_value numeric; -- percent value when type = 'percent'

alter table strategies add column if not exists target_type text not null default 'percent'
  check (target_type in ('percent','r_multiple'));
alter table strategies add column if not exists target_value numeric; -- percent, or R-multiple (e.g. 5 for 1:5), depending on target_type

alter table strategies add column if not exists max_risk_points numeric; -- skip entry if stop distance exceeds this

-- Snapshot the actual stop/target price at the moment of entry, since
-- candle-based levels change every candle and must be frozen once a trade opens.
alter table paper_trades add column if not exists stop_price numeric;
alter table paper_trades add column if not exists target_price numeric;
alter table paper_trades add column if not exists risk_points numeric;
