-- Deletes the duplicate trades that were just closed at ₹0 during cleanup,
-- so they stop diluting your win rate. Only targets recently-closed ₹0
-- trades - your real trades (with actual P&L) are untouched.
delete from paper_trades
where status = 'closed' and pnl = 0 and exit_time > now() - interval '1 hour';
