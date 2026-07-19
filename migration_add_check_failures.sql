alter table paper_trades add column if not exists position_check_failures integer not null default 0;
alter table paper_trades add column if not exists notes text;
