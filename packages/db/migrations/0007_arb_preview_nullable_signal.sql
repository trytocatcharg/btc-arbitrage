-- Hand-written like 0004/0006: drizzle-kit generate cannot be trusted here
-- (snapshot drift in migrations/meta makes it re-emit statements for existing
-- tables). Only the signal_id nullability change belongs in this migration.
--
-- /arb screener trades (ORBIT arbitrage rows) create trade_previews rows
-- without a signals row — the prepare step is driven by the screener, not by
-- the signal engine — so trade_previews.signal_id must accept NULL. MODIFY
-- keeps the existing foreign key and the column type intact, and is naturally
-- idempotent.
ALTER TABLE `trade_previews` MODIFY `signal_id` int NULL;
