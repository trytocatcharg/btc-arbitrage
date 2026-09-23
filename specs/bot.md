# Bot specification

## Purpose

`apps/bot` is the **execution owner** of the project.

It:

- monitors spreads,
- creates signals,
- sends Telegram alerts,
- exposes the Telegram confirmation workflow,
- and executes real arbitrage trades after Telegram confirmation.

## Runtime

- Entry point: `apps/bot/src/main.ts`
- Main loop: `apps/bot/src/runtime/polling-loop.ts`
- Exchange registry: `apps/bot/src/exchanges/registry.ts`

Boot flow:

1. load bot config,
2. connect DB,
3. create exchange registry,
4. configure Telegram commands,
5. start monitoring loop.

## Monitoring loop

The bot continuously:

1. polls Telegram commands/callbacks,
2. monitors existing live trades for leg closure / unhedged states,
3. fetches price snapshots from `EXCHANGE_A` and `EXCHANGE_B`,
4. computes spread via `calculateSpread`,
5. runs `SignalEngine`,
6. persists qualifying signals in DB,
7. sends Telegram alerts.

## Signal creation

When a spread qualifies:

- a row is inserted into `signals`,
- the bot resolves a durable `signalId`,
- Telegram receives a signal message with:
  - text summary,
  - **Open Trade** inline button.

The bot includes fallback lookup logic when MySQL/Drizzle does not return a reliable `insertId`.

## Telegram behavior

### Outbound alerts

Implemented in:

- `apps/bot/src/notifications/telegram-notifier.ts`

Behavior:

- restricted to `TELEGRAM_CHAT_ID`,
- global cooldown,
- signal message includes **Open Trade** button when `signal.id` exists,
- urgent notifications are used for rollback/unhedged alerts.

### Inbound commands

Implemented in:

- `apps/bot/src/notifications/telegram-command-poller.ts`

Current chat commands:

- `/config`
- `/trade`

### Inline callback flow

Supported callbacks:

- `open:<signalId>`
- `confirm:<previewToken>`
- `cancel:<previewToken>`

Behavior:

- `open:` creates a preview and sends a **Confirm / Cancel** message.
- `confirm:` executes the arbitrage flow.
- `cancel:` marks preview cancelled and deletes the preview message.

## Open Trade workflow

Implemented in:

- `apps/bot/src/trading/open-trade.ts`
- `apps/bot/src/trading/db-preview-store.ts`

### Preview stage

The bot recalculates executable BBO before building the preview.

It determines:

- **shortExchange** = exchange with higher executable `bid`
- **longExchange** = the other exchange

Then it decides execution mechanics:

- It evaluates the only two valid entry layouts:
  - maker on `longExchange`, taker on `shortExchange`
  - maker on `shortExchange`, taker on `longExchange`
- It chooses the layout with the **lowest maker fee first**.
- If maker fees tie, it chooses the layout with the **lowest taker fee**.
- Therefore:
  - **limitExchange** = exchange chosen for the maker leg
  - **marketExchange** = opposite exchange used for the taker hedge

Previews are persisted in `trade_previews`.

### Confirm stage

When confirmed:

    1. consume preview,
    2. create `trades` + `trade_legs`,
    3. place the maker leg as **limit**,
    4. hedge any filled quantity on the opposite exchange with **market**,
    5. place TP/SL protection on both legs (exchange-side backstop): one
       `take-profit-market` + one `stop-market` reduce-only trigger per leg on
       its own exchange, anchored to that leg's own fill.
    
    **Margin-based percentages (since 2026-09-21)**: `OPEN_TRADE_TAKE_PROFIT_PERCENT`
    and `OPEN_TRADE_STOP_LOSS_PERCENT` are defined **on the margin**, not on
    price. The price-side trigger distance divides by `LEVERAGE` (at 5x: 3% TP
    = 0.6% price, 2.5% SL = 0.5% price), so the ROI on margin at each trigger
    equals the configured percentage. A loud sanity check throws (→ rollback)
    if any trigger lands on the wrong side of its leg's fill.
    
    **Disabled exits (since 2026-09-21)**: the fill-time edge band
    (`EDGE_BAND_ENABLED = false` in `open-trade.ts`) and the time-stop close
    (`BOT_TIME_STOP_ENABLED` env gate in `timeout-close-monitor.ts`) are
    disabled. The edge evaluation still runs and logs for diagnostics but never
    closes. When one leg's TP/SL fills, the sibling stays open: the position
    monitor marks the trade `unhedged` and notifies urgently. The
    stale-`closing` recovery sweep stays active regardless.
    
    The execution setup (leverage set on RISEx, order-signing WASM init on
    Extended) runs **once at bot startup**, not per trade; per-trade preflight and
    margin reads were removed from the confirm path so the entry reaches the
    exchange faster. Misconfiguration surfaces at boot (fatal) or at the submit
    step.
    
    Protection percentages are configurable from env (defined **on the
    margin** since 2026-09-21; the price-side trigger distance divides by
    `LEVERAGE`):
    
    - `OPEN_TRADE_TAKE_PROFIT_PERCENT` (margin ROI at the TP trigger)
    - `OPEN_TRADE_STOP_LOSS_PERCENT` (margin ROI at the SL trigger)

### Important execution rules

- Execution happens **only after Telegram confirmation**.
- Routing rule is permanent: **maker fee wins first, taker fee breaks ties**.
- `maker = limit order`
- `taker = market order`
- The maker leg no longer uses the stale preview price.
- At confirm time it recalculates a **fresh passive limit** from live BBO:
  - buy -> `best bid + OPEN_TRADE_ENTRY_IMPROVE_TICKS × tick` (only while strictly below the ask, else join best bid)
  - sell -> `best ask − OPEN_TRADE_ENTRY_IMPROVE_TICKS × tick` (only while strictly above the bid, else join best ask)
- `OPEN_TRADE_ENTRY_IMPROVE_TICKS=0` restores the legacy join-best behavior. The same improved pricing is used when repricing, so the resting order is not needlessly cancelled.
- If RISEx rejects with `PostOnlyOrderMatched()`, the bot retries the passive limit automatically.
- While the maker leg rests, the bot reprices it every `OPEN_TRADE_REPRICE_INTERVAL_MS` (default 2000 ms; 0 disables): if the top of the book moved, the resting order is cancelled and re-submitted post-only at the new best bid (buy) / ask (sell). Partial fills are settled first and the remainder is re-submitted; the TP/SL anchor uses the fill-weighted average price across all resting orders.

## Exchange execution ownership

### RISEx

The bot owns the adapted RISEx SDK and signing flow under:

- `apps/bot/src/exchanges/risex/sdk/*`

Implemented live capabilities include:

- leverage update,
- signed place/cancel,
- TP/SL placement,
- executable BBO from orderbook,
- position lookup,
- margin lookup.

RISEx exchange client initialization is lazy so transient exchange errors do not kill the whole bot at startup.

### Extended

Implemented live capabilities include:

- signed `LIMIT`,
- signed `MARKET`,
- signed `TPSL`,
- order lookup,
- cancel,
- position lookup,
- available margin,
- Stark signing context loading.

## Exits, protection, and edge validation

Implemented in:

- `apps/bot/src/trading/timeout-close-monitor.ts` (time-stop + recovery sweep)
- `apps/bot/src/trading/trade-close.ts`
- `apps/bot/src/trading/open-trade.ts` (per-leg anchoring + fill-time edge band)

Spread-USD exits were removed by adjust-tpsl-volume-farming: there are no
spread-USD comparisons on open trades (`OPEN_TRADE_SPREAD_TP_USD` /
`OPEN_TRADE_SPREAD_SL_USD` are rejected at config load). The exit model is:

- **Venue-side per-leg TP/SL backstop** (primary risk layer): reduce-only
  TP/SL orders anchored to each leg's OWN fill price — long TP = longFill ×
  (1+`OPEN_TRADE_TAKE_PROFIT_PERCENT`), long SL = longFill × (1−`OPEN_TRADE_STOP_LOSS_PERCENT`
  default 2.5); the short leg's TP sits below its fill and its SL above it.
  RISEx triggers on MARK price; Extended stays LAST-triggered. A 100 bps
  tolerance + cross-symmetry assertion runs before placement; a breach fails
  loudly (rollback + urgent notify) instead of placing mis-anchored orders.
- **Time-stop** (orthogonal): a trade open for
  `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` (default 30) minutes is closed
  reduce-only with reason `spread_timeout`, regardless of spread moves.
- **Stale-`closing` recovery sweep**: a trade stuck in `closing` is re-closed
  (`close_recovery`).
- **Fill-time edge band**: right after both fills, the trade is kept iff
  expected convergence ≥ round-trip breakeven (entry maker/taker fees + exit
  taker fees + `OPEN_TRADE_SLIPPAGE_BPS` slippage) + `OPEN_TRADE_MIN_PROFIT_USD`
  (default $0.05); otherwise both legs close immediately reduce-only with
  reason `edge_below_cost` and the Telegram `edge_closed` notice fires. An
  abort loss beyond `OPEN_TRADE_MAX_LOSS_USD` (default $0.25) logs/notifies a
  fee-model-drift alert.
- Closure persists per-leg exit prices and realized PnL, the trade-level
  realized PnL, and the cumulative farmed volume; Telegram gets a `📕 Trade #N
  closed (reason)` message with the PnL and farmed volume.

## Trade monitoring

Implemented in:

- `apps/bot/src/trading/trade-monitor.ts`

The bot monitors open/unhedged legs and sends urgent Telegram alerts when one leg closes and the remaining leg is exposed.

Close reasons are best-effort and depend on each exchange adapter.

## Logging and observability

The bot does not write JSONL log files. Observability is provided by:

- structured `console` output (bot log level via `LOG_LEVEL`),
- the `events` table in MariaDB (persisted bot events),
- Telegram notifications for operator-facing trade state changes.

## Guardrails

- Telegram is the only approved operator surface for opening trades.
- Web must not open trades.
- Backend must stay read-only.
- Exchange live flags must still be explicitly enabled in config.
