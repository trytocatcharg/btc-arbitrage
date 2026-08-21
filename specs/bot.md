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
3. run preflight on both exchanges,
4. place the maker leg as **limit**,
5. hedge any filled quantity on the opposite exchange with **market**,
6. if covered quantity exists, place TP/SL protection on both legs.

Protection percentages are configurable from env:

- `OPEN_TRADE_TAKE_PROFIT_PERCENT`
- `OPEN_TRADE_STOP_LOSS_PERCENT`

### Important execution rules

- Execution happens **only after Telegram confirmation**.
- Routing rule is permanent: **maker fee wins first, taker fee breaks ties**.
- `maker = limit order`
- `taker = market order`
- The maker leg no longer uses the stale preview price.
- At confirm time it recalculates a **fresh passive limit** from live BBO:
  - buy -> current `bid`
  - sell -> current `ask`
- If RISEx rejects with `PostOnlyOrderMatched()`, the bot retries the passive limit automatically.

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

## Trade monitoring

Implemented in:

- `apps/bot/src/trading/trade-monitor.ts`

The bot monitors open/unhedged legs and sends urgent Telegram alerts when one leg closes and the remaining leg is exposed.

Close reasons are best-effort and depend on each exchange adapter.

## Logging and observability

Important JSONL logs:

- `apps/bot/logs/risex-http.jsonl`
- `apps/bot/logs/extended-http.jsonl`
- `apps/bot/logs/open-trade.jsonl`
- `apps/bot/logs/telegram-commands.jsonl`

These logs trace:

- exchange HTTP traffic,
- Telegram callbacks,
- preview creation,
- confirm flow,
- preflight,
- maker submission,
- hedge submission,
- protection submission,
- rollback attempts,
- confirmation failures.

## Guardrails

- Telegram is the only approved operator surface for opening trades.
- Web must not open trades.
- Backend must stay read-only.
- Exchange live flags must still be explicitly enabled in config.
