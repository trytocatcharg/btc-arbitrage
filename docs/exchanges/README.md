# Exchange specs

These specs are the local operating contract for each exchange integration. They do not replace official docs; they pin the decisions this bot currently relies on.

| Exchange | Spec | Official docs |
|---|---|---|
| RISEx | [risex.md](./risex.md) | https://docs.risechain.com/docs/risex |
| Extended | [extended.md](./extended.md) | https://api.docs.extended.exchange/#extended-api-documentation |
| Arcus | [arcus.md](./arcus.md) | https://docs.arcus.xyz/ |

Before enabling live trading, update the relevant spec first, then update the adapter.

## Accounting invariant (all exchanges)

Realized PnL accounting is **exchange-agnostic by design** — do NOT add
per-exchange branches to it:

- Bot-derived realized values are always **GROSS** (fee-free); the canonical
  net is `realized − total_fees_usd` (operator decision 2026-10-07).
- Every accounting path derives the leg gross from `entry/exit/qty` first.
  The venue-reported `realizedPnlUsd` is a **fallback only** when the exit
  price is unknown — its fee convention varies by exchange (Arcus nets the
  exit fee into it; Extended reports none at all; RISEx reports gross), so
  trusting it when the exit price is known double-counts fees (bug hit in
  trade #637: stored net −$0.11 vs real +$0.15).
- **When adding a new exchange**, the only contract the accounting relies on
  is: the execution adapter must surface `exitPriceUsd` and `feeUsd` on
  closed positions and leg-closure resolutions (`getPosition`,
  `resolveLegClosure`). Document the venue's `realizedPnlUsd` fee convention
  in this exchange's spec; the code must not depend on it.

Testing policy: by explicit user instruction on August 16, 2026, unit-test work is paused. Do not add or expand unit tests in this repo until the user says otherwise.
