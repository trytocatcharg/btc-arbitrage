# Feature: Multi-pair trading (runtime pair switch)

Operator-selectable trading pair from the Telegram `/config` panel (new
"Pairs" button next to "Auto trade"). The pair drives every downstream
consumer through the shared `BotConfig.btcSymbol` (price polling, signals,
open-trade previews, execution) — no restart needed. Pair list is a shared
catalog so adding a pair later is a one-line change.

Default pair BTC/USD (`BTCUSDT`); initial catalog also includes ETH/USD
(`ETHUSDT`) and NVDA/USD (`NVDAUSDT`). All venues resolve the canonical
symbol by base-asset matching (RISEx lists `BTC`/`ETH`/`NVDA`, Extended and
Arcus list `BTC-USD` style) — no per-venue symbol mapping table needed.

Product decisions (with operator):
- Pair switch is BLOCKED while a trade is active or an execution is
  in-flight (same guard family as `/bot` restart).
- `MIN_PRICE_DIFF_USD` stays global across pairs (already runtime-adjustable).
- On switch, re-run the execution preflight (RISEx `updateLeverage` is
  per-market) for the new symbol on trading-enabled adapters.

## Tasks

- [x] 1. Pair catalog in `packages/domain`: `TRADING_PAIRS` (BTC/USD default,
  ETH/USD, NVDA/USD) + lookup helpers (`findTradingPair`,
  `isSupportedTradingSymbol`). Telegram buttons and the runtime applier both
  consume the catalog — adding a pair = one line.
- [x] 2. Runtime setting `tradingPair` in `apps/bot/src/runtime/`: applier
  `applyTradingPair` (validates against catalog, mutates `config.btcSymbol`),
  persistence in `runtime-settings-store.ts` (`bot_runtime_overrides`,
  survives restart), `*` override marker in the `/config` summary.
  Done: `runtime-settings.ts` (key, baseline, applier, override check) +
  `runtime-settings-store.ts` (read/parse/apply); typecheck green.
- [x] 3. 24h traded volume per exchange: optional `getMarketStats?` on
  `ExchangeAdapter` (`exchange-core`), implemented in the three market-data
  clients reusing their existing public markets payloads. Exact volume field
  verified live per venue; missing field renders "n/d" (never estimated).
- [x] 4. Telegram UX in `notifications/telegram-command-poller.ts`: "Pairs"
  button + per-pair buttons generated from the catalog (current pair marked);
  tap fetches 24h volume for each ACTIVE exchange via the registry →
  two-step Confirm/Cancel; confirm path blocked on active trade / in-flight
  execution, then applies + persists the pair and re-runs execution
  preflight for the new symbol. Operator copy in Spanish.
- [x] 5. Remove the `tradingEnabled` exchange-id hardcode in `main.ts`:
  use `adapter.capabilities.orderPlacement` (each client already mirrors its
  `config.*.tradingEnabled`); Arcus fee-schedule block derives from the same
  capability.
- [x] 6. Remove the `logs/exchange-response-responses.jsonl` response logger:
  deleted `exchanges/exchange-response-logger.ts` + its 20 call sites (12
  RISEx, 5 Arcus, 3 Extended) + 3 imports. `.gitignore` keeps the generic
  `logs` entry (harmless).

## Notes

- No DB migration needed: `symbol` is already stored per row in
  price/spread/signal/trade tables; `bot_runtime_overrides` columns fit.
- Persisted-override restore in `main.ts` runs BEFORE the registry and the
  boot preflight, so a restored pair is preflighted with the right symbol.
- Unit tests paused by user instruction (2026-08-16) — no new tests.
- Web dashboard untouched (read-only, no pair surface required).
