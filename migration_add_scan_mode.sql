alter table strategies add column if not exists entry_scan_mode text not null default 'full_scan'
  check (entry_scan_mode in ('full_scan','latest_only'));
