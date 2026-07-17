-- Step 1: close all but the most recent open/pending duplicate per strategy
-- per day (this is what caused the "so many trades" bug you saw).
with ranked as (
  select id, row_number() over (
    partition by strategy_id, trade_date
    order by entry_time desc
  ) as rn
  from paper_trades
  where status in ('open','pending_confirmation')
)
update paper_trades
set status = 'closed', pnl = 0, exit_time = now()
where id in (select id from ranked where rn > 1);

-- Step 2: now safe to add the rule that prevents this from ever happening again.
create unique index if not exists one_open_trade_per_strategy_per_day
  on paper_trades (strategy_id, trade_date)
  where status in ('open','pending_confirmation');
