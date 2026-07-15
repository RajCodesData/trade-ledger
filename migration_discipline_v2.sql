-- Run in Supabase SQL Editor. This replaces the earlier
-- migration_add_discipline.sql approach - if you already ran that one and
-- created an active_trades table, it's safe to ignore/drop it, it's no
-- longer used.

alter table paper_trades add column if not exists is_live boolean not null default false;
alter table paper_trades add column if not exists confirmed_square_off boolean not null default false;
alter table paper_trades add column if not exists screenshot_url text;
alter table paper_trades add column if not exists hit_type text; -- 'stop' or 'target'
alter table paper_trades add column if not exists last_nag_sent_at timestamptz;

-- Allow the new "pending_confirmation" status alongside the existing ones.
alter table paper_trades drop constraint if exists paper_trades_status_check;
alter table paper_trades add constraint paper_trades_status_check
  check (status in ('open','closed','pending_confirmation'));

-- Private storage bucket for square-off screenshots - only you can access your own.
insert into storage.buckets (id, name, public)
values ('trade-screenshots', 'trade-screenshots', false)
on conflict (id) do nothing;

create policy "own screenshot uploads" on storage.objects
  for insert with check (bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own screenshot reads" on storage.objects
  for select using (bucket_id = 'trade-screenshots' and (storage.foldername(name))[1] = auth.uid()::text);
