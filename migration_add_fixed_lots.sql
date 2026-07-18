alter table strategies drop constraint if exists strategies_position_sizing_mode_check;
alter table strategies add constraint strategies_position_sizing_mode_check
  check (position_sizing_mode in ('fixed_qty','risk_based','fixed_lots'));
