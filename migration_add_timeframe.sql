alter table strategies add column if not exists timeframe text not null default '5m'
  check (timeframe in ('1m','3m','5m','15m','30m','1h'));
