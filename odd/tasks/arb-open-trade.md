# Feature: /arb Open Trade — prepare + confirm sobre filas del screener ORBIT

Estado: en implementación (2026-10-30)

## Decisions del operador (preguntadas, no inventadas)

1. **Colisión Arcus + metal activo**: BLOQUEAR la pata Arcus. Si la fila propone arcus como long o short y hay un trade GOLDSILVER activo (`loadActiveMetalTrade`), el prepare se niega con mensaje claro. Filas sin pata Arcus operan normales. Re-chequear también al confirmar (race: metal abierto entre prepare y confirm).
2. **Sizing separado**: nueva sección `arbTrade` en BotConfig — `ARB_TRADE_MARGIN_USD` (default 20), `ARB_TRADE_LEVERAGE` (default 3), `ARB_TRADE_TAKE_PROFIT_PERCENT` (default 3), `ARB_TRADE_STOP_LOSS_PERCENT` (default 2.5). Desacoplado de los runtime settings de BTC.
3. **Entrada**: reutilizar el flujo BTC completo (limit post-only maker + hedge market + TP/SL reduce-only, reprice, anti-chase, cancel-race, rollback) mediante una SEGUNDA instancia de OpenTradeService con OpenTradeOptions override.

## Contexto técnico (scout 2026-10-30, file:line verificados)

- `trades.signal_id` ya nullable (`schema.ts:180`); `trade_previews.signal_id` NOT NULL (`schema.ts:229`) → migration 0007 (ALTER TABLE, hand-written siguiendo patrón 0006; NO correr `yarn db:generate` — hay drift de snapshots conocido).
- Sizing/leverage/TP/SL se leen de `this.options` en open-trade.ts (live, nunca del preview): seam = options override en factory (`open-trade-factory.ts` buildOpenTradeOptions ~L25-85). `marketType` hardcoded "perpetual" (~L889-905), ok para perps.
- `minSpreadUsd` = `config.minPriceDiffUsd` ($40 absolutos) alimenta el spread-viability watch — inválido para /arb → override 0 (deshabilita salvo spread negativo; verificar semántica del check).
- `OpenTradePreview` (`open-trade.ts:45-61`): token (randomUUID), signalId, expiresAt, symbol, marketType, long/short/limit/marketExchange, quantityBase, long/shortPriceUsd, maker/takerFeeBps. TTL atómico en consumePreview (`db-preview-store.ts`).
- trade-monitor.ts: agnóstico a símbolo (filtra por status) → monitorea /arb bien. position-reconciler.ts: scoped a `config.btcSymbol` + exchangeA/B → NO ve posiciones /arb (gap aceptado, documentar).
- `loadActiveMetalTrade({ db })` exportado (`metal-trade-service.ts:47-49`).
- Todos los adapters (arcus/extended/qfex/risex) tienen getMarketMetadata/getBestBidOffer/validateExecutionPreflight. Registry siempre construye los 4.
- Gap: QFEX exige símbolo canonical tipo `CRCLUSD` (qfexSymbolFor/extractBaseAsset); verificar canonicalización por venue antes de createPreview.
- Boot preflight (main.ts) solo cubre `config.btcSymbol` → /arb debe correr `validateExecutionPreflight({symbol, leverage})` por pata al prepare (patrón: metal-trade-service createMetalTrade).

## Tasks

1. [x] Migration 0007 (`trade_previews.signal_id` nullable) + widening `signalId: number | null` (schema.ts, open-trade.ts, db-preview-store passthrough; fallback lookup de startExecution degrada con NULL — aceptado).
2. [x] Config `arbTrade` en packages/config (patrón goldSilver) + .env.example.
3. [x] Seam factory: builder de servicio /arb con options override (sizing + minSpreadUsd 0; autoConfirm false forzado).
4. [x] Screener client: callback codifica venues (`arbopen:<SYM>:<LONG>:<SHORT>` ≤64B) + canonicalización (uniforme: cada adapter normaliza el base symbol; variational rechazada).
5. [x] Poller: `arbopen:` = metal-guard (arcus leg) + preflight por pata + createPreview + resumen con [Confirm]/[Cancel]; `arbconfirm:<token>` = re-guard + queue confirm; `arbcancel:<token>` = cancel preview (solo awaiting_confirmation).
6. [x] Docs (AGENTS.md) + verificación.

## Evidence

- Implementado por gentle-ai-worker, verificado por gentle-ai-verify (2026-10-30): veredicto **mergeable**, 8/8 ítems PASS, `yarn typecheck` exit 0, flujo BTC probado intacto.
- Hallazgos del verify (informativos, no bloqueantes):
  - `arbconfirm:` no verifica que el preview sea de /arb (un token BTC hand-crafted correría con options ARB) — self-inflicted only (solo el chat operador manda callbacks).
  - El confirm-time metal refusal transiciona el preview a `cancelled` (limpieza deliberada para no dejar `hasBlockingExecution` trabado hasta el TTL).
- Caveats operativos:
  - **Migration 0007 NO aplicada** — correr `yarn db:migrate` antes del primer confirm en vivo.
  - QFEX + PRICE_SOURCE=mark: el reprice se saltea silenciosamente durante la entry (QFEX no tiene mark REST) — el limit queda al precio inicial hasta fill/timeout.
  - La dirección del preview se re-deriva del BBO en vivo: puede invertirse vs la fila del screener (el mensaje de preview muestra la dirección real).
  - Position reconciler no cubre posiciones /arb (gap aceptado, en AGENTS.md).
