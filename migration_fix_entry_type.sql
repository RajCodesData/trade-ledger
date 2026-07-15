-- Fixes strategy saving: several columns from the original version of this
-- feature were marked required (NOT NULL) with no default. The new rule
-- engine doesn't populate them anymore, so make them all optional.

alter table strategies alter column entry_type drop not null;
alter table strategies alter column stop_loss_pct drop not null;
alter table strategies alter column target_pct drop not null;
