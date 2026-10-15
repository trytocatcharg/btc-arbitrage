# Feature: /volume directo desde exchanges

## Contexto

El `/volume` del bot hoy suma `filled_notional_usd` de la BD (convención D6,
con gaps históricos de atribución). El operador quiere que los números vengan
**directo de los exchanges** para los 3 exchanges registrados (extended, risex,
arcus), manteniendo el formato actual: total, mes anterior, últimos 6 meses.

Endpoints verificados (2026-10-15, en uso, read-only):
- Extended: `GET /api/v1/user/trades?market=BTC-USD` — privado (X-Api-Key).
  Respuesta `{status, data[]: {side, averagePrice, filledQty, value, fee,
  tradeType, createdTime(ms)}, pagination: {cursor}}`. `value` = notional
  exacto del fill. Máx 10k registros, paginar con `cursor` (repetir hasta
  página vacía o cursor repetido; cap de páginas).
- Arcus: `GET /v1/fills?address=<acct>&market=BTC-USD` — público.
  `fills[]: {orderId, side, size, price, fee, positionEffect, createdAt(µs)}`
  (newest-first). Notional = size × price.
- RISEx: `GET /v1/trade-history?account=&market_id=&limit=50` (el adapter ya
  lo usa para fills: campos `price`, `size`, `fee`, `order_id`). Verificar
  paginación/offset en vivo.

## Diseño

1. Contrato (`packages/exchange-core/src/index.ts`): método opcional
   `getAccountFills?(input: {symbol: string}): Promise<AccountFill[]>`;
   `AccountFill = { notionalUsd: string; side: "buy"|"sell"; occurredAt: Date; feeUsd?: string }`.
2. Implementar en los 3 execution adapters (resolución symbol→market interna,
   igual que `getMarket`).
3. Servicio `apps/bot/src/trading/exchange-volume.ts`: agrega fills por exchange;
   TTL cache 60s; fallback por exchange a los valores de BD (`volume-stats.ts`)
   con sufijo "· db" si el exchange falla o no aplica.
4. `buildVolumeMessage` (telegram-command-poller.ts): volumen por exchange;
   **bloque net-PnL se queda en BD** (`loadNetPnlTotals`, formato igual).
   Meses atribuidos por mes del **fill** (UTC). Actualizar
   `VOLUME_ATTRIBUTION_NOTE` y la descripción del comando en
   `configureAvailableCommands`.
5. Docs: spec del `/volume` donde viva (revisar specs/bot.md / docs).

## Restricciones

- Sin tests nuevos (pausa explícita del usuario).
- Degradación graceful: exchange caído → BD + nota, nunca tirar el comando.
- yarn typecheck exit 0. Smoke opcional read-only (imprimir totales), borrar scratch.

## Evidencia

- `yarn typecheck` exit 0 (observado en esta sesión).
- Smoke real contra los 3 exchanges: risex 157 fills $23,710.89; extended 540 fills $141,219.83; arcus 114 fills $118,746.52; sin fallback a BD.
- Estado: **completado** (2026-10-15). Commits pendientes (decisión del usuario).
