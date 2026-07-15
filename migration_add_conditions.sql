-- Run in Supabase SQL Editor after the earlier strategy migration

alter table strategies add column if not exists entry_conditions jsonb;
alter table strategies add column if not exists last_metrics jsonb;

-- entry_type/entry_level from the earlier version are no longer used by the
-- new rule engine, but are left in place so nothing breaks - safe to ignore.
