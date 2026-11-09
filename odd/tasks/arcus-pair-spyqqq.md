# Arcus-pair strategies: SPY/QQQ (feature)

## Goal

Add a second Arcus pair-trade strategy, SPY/QQQ (SPY-USD / QQQ-USD perps),
as a sibling of the existing gold/silver (GOLDSILVER) strategy — same entry,
exit, and protection machine, parameterized instead of duplicated.

## Operator decisions (2026-11-1x)

1. Arcus markets verified live: `SPY-USD` (marketId 23) and `QQQ-USD`
   (marketId 24), both ONLINE, same tick structure as GLD/SLV
   (tickSize 0.01, minOrderNotional 5). 24h notional ~$60M / ~$32M (vs
   GLD ~$5M / SLV ~$1.8M) — considerably more liquid than metals.
2. Chart/RSI data source: Yahoo `SPY`/`QQQ` ETFs (direct, liquid).
   Futures (`ES=F`/`NQ=F`) only as fallback if ETFs fail.
3. **One Arcus-pair trade globally** — a metal trade and an SPYQQQ trade can
   never be open at the same time (shared single-trade lock).
4. Own config: `SPYQQQ_*` env section, independent defaults/values.
5. New Telegram command `/etf` (chart + RSI + open buttons), mirroring
   `/ratio`.

## Architecture

Registry of Arcus-pair strategies; services take a strategy spec instead of
hardcoded GOLDSILVER/GLD/SLV:

```ts
interface ArcusPairStrategySpec {
  /** Pseudo-symbol stored in trades.symbol (also the registry key). */
  symbol: "GOLDSILVER" | "SPYQQQ";
  label: string;            // "Metals" / "ETFs"
  emoji: string;            // 🥇 / 📈
  entryMarket: string;      // GLD-USD / SPY-USD (passive ALO leg)
  hedgeMarket: string;      // SLV-USD / QQQ-USD (IOC hedge + order-book gate)
  yahooSymbols: [string, string]; // GC=F/SI=F / SPY/QQQ
}
```

`ratio_snapshots` has NO symbol column today → migration 0009 adds
`pair_symbol` (backfill GOLDSILVER); gold/silver price columns serve as
legA/legB. `bot_runtime_overrides` is key-value → new SPYQQQ setting keys
need no migration.

## Tasks (work-unit commits)

- [ ] 1. **arcus-pair registry + pure refactor** — descriptor, registry
      (`GOLDSILVER` spec from existing constants), `isArcusPairSymbol()`
      helper replacing bare GOLDSILVER scoping checks. Behavior identical.
- [ ] 2. **SPYQQQ config + service generalization** — reusable strategy
      config shape in `@btc-arbitrage/config`; `spyQqq` section from
      `SPYQQQ_*` env (defaults mirror GOLDSILVER); services resolve
      `config.goldSilver.*` through the spec. Typecheck green.
- [x] 3. **SPYQQQ instance** — registry entry; `/etf` command (Yahoo
      SPY/QQQ, chart title `SPYQQQ (SPY/QQQ)`); global single Arcus-pair
      trade lock (loadActiveMetalTrade → any-strategy); `/config` 📈 ETFs
      submenu + 5 runtime settings with persistence; BTC↔Arcus collision
      guard covers both strategies; migration 0009 (`ratio_snapshots`
      pair_symbol); `/trade` summary leg labels per strategy.
- [ ] 4. **Docs + env example** — AGENTS.md, docs, `.env.example`
      `SPYQQQ_*` block; final typecheck; report.
- [x] 5. **Tests** — re-enable test work for this feature (explicit
      operator request 2026-11-1x, superseding the 2026-08-16 pause):
      fix existing tests broken by the refactor and add coverage for the
      registry, the SPYQQQ config parsing, and the global single-trade
      lock. Run `yarn test`. → bot 75/75, config 11/11, domain 2/2;
      metal fixtures gained strategy/strategyConfig; new
      arcus-pair-strategies.test.ts + global-slot test + config cases.

## Evidence

- `curl https://api.arcus.xyz/v1/markets?market=SPY-USD` → ONLINE,
  marketId 23; QQQ-USD → ONLINE, marketId 24 (checked 2026-11-1x).
- Strategy code today: `apps/bot/src/metal-ratio/` ≈ 2.5k lines
  (`metal-trade-service.ts` 1.766) + wiring (config section, runtime
  settings, poller `/ratio` + callbacks, polling-loop tick, trade-monitor
  throttle, reconciler scoping).
