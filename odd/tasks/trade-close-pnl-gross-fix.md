# Trade-close PnL: always-gross aggregation fix

## Problem

Trade #637 (2026-10-09) closed with a Telegram notice of **net +$0.15** but the
`#lasttrades` summary showed **−$0.11**. Root cause: two writers of
`trades.realized_pnl_usd` preferred the venue-reported `leg.realizedPnlUsd`
over the gross value derived from `entry/exit/qty`. Arcus nets the exit fee
into its reported realized PnL, so the exit fee was subtracted twice:
once inside the venue value, once again via `trades.total_fees_usd`.

## Conventions (operator decisions)

- realized PnL columns are always **GROSS** for bot-derived values;
  exchange-reported values are stored as-is but never trusted for
  accounting when the exit price is known.
- Canonical net = `realized − total_fees`.
- Venue-reported `realizedPnlUsd` is a **fallback only** when `exitPriceUsd`
  is unknown (then fees are unknown too, so no double count is possible).

## Tasks

- [x] 1. Diagnose: trade #637 data check + writer-path audit (`trade-monitor.ts`
  close aggregation; `trade-close.ts closeTradeBothLegs`).
- [x] 2. Fix `apps/bot/src/trading/trade-monitor.ts` close aggregation to use
  the same gross-first rule as `deriveLegGrossPnlUsd` (reuse the helper).
- [x] 3. Fix `apps/bot/src/trading/trade-close.ts` (`closeTradeBothLegs`) to
  derive gross per leg from exit/entry/qty first; venue value only as
  fallback for the trade total.
- [x] 4. Document the accounting invariant for future exchanges
  (`docs/exchanges/README.md`): adapters must surface exitPriceUsd/feeUsd;
  venue realizedPnlUsd conventions are documented per exchange but never
  trusted when exit price is known.
- [x] 5. Verify: `yarn typecheck` ✅; re-ran the impact query — 34/42 closed
  trades now match gross exactly, 0 fee-explainable diffs remain.
- [x] 6. Repair historical `trades.realized_pnl_usd`: 14 trades updated
  (#342, #471, #481, #483, #506, #509, #513, #550, #555, #578, #600, #602,
  #636, #637). Criterion: diff stored-vs-gross fully explainable by known
  fees. 8 trades skipped (unexplained diffs = separate data-quality issue):
  #113, #128, #167, #174, #212, #218, #313, #447. Audit snapshot:
  `odd/evidence/trade-close-pnl-repair-2026-10-09.json`. #637 now nets
  +$0.1508, matching the closure notice.

## Evidence

- Trade #637: legs 1263 (extended long, venue realized null → derived gross
  +5.0163) and 1264 (arcus short, venue −4.3392 = gross −4.0828 net of
  exit fee 0.2563). Stored trade realized 0.6771; fees 0.7827; summary net
  −0.1056 vs correct +0.1509.
- Impact scan: 22 of 42 closed trades differ gross-vs-stored; only the
  fee-explainable subset is in scope for repair.
