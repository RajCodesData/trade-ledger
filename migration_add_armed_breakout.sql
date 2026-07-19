alter table strategies add column if not exists armed boolean not null default false;
alter table strategies add column if not exists armed_level numeric;
alter table strategies add column if not exists armed_updated_at timestamptz;

alter table strategies drop constraint if exists strategies_entry_scan_mode_check;
alter table strategies add constraint strategies_entry_scan_mode_check
  check (entry_scan_mode in ('full_scan','latest_only','armed_breakout'));
