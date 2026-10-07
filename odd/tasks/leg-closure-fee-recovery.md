# Leg closure fee recovery — extended fills fallback + arcus entry fee

Post-mortem del trade #447 (2026-10-06): la pata long de extended fue cerrada a mano
y el monitor reportó exit/pnl `n/a` porque `resolveLegClosure` de extended solo consulta
los TP/SL guardados. Arcus sí tiene fallback a fills; extended no. Además la fee de
entrada taker de arcus (hedge market) nunca se captura: `entry_fee_usd` queda NULL y
`total_fees_usd` subestima el round-trip.

## Tasks

- [x] 1. Verificar endpoint `GET /api/v1/user/trades` de Extended (hecho vía doc oficial + CCXT: existe, privado por X-Api-Key, items con orderId/averagePrice/filledQty/fee/tradeType/side, descendente, max 10.000)
- [x] 2. Fallback a fills en `resolveLegClosure` de extended
  (hecho: `resolveClosureFromFills` vía `GET /api/v1/user/trades`, VWAP exacto + fee real,
  LIQUIDATION detection, piso 50%, quantityBase opcional; helpers decimales nuevos en el adapter)
- [x] 3. Recuperar fee de entrada de arcus desde `/v1/fills` en `getExecutionOrder`
  (hecho: `resolveOrderFeeCached` memoizado por orderId, `fetchFillsByMarket` split,
  fee real attachada a `ExecutionOrder.feeUsd` solo cuando filled y sin fee)
- [x] 4. Typecheck (`yarn typecheck`) — exit 0
- [ ] 5. Query SQL de corrección para el trade #447 (la entrega el orquestador)

## Constraints

- Sin tests unitarios (pausados por instrucción explícita del usuario).
- Sin commits ni push: el usuario commitea solo. Dejar todo en working tree.
- Artefactos técnicos en inglés (código/comentarios/docs).
- Nunca estimar fees: solo valores reales del venue; degradar a NULL.

## Evidence

- `~/Downloads/exchange-responses.jsonl` (24 eventos, trade #447)
- DB: trade_legs #447 extended todo NULL, close_reason 'unknown'; arcus exit_fee 0.16038581 / pnl −3.91443581
- Docs: `docs/exchanges/extended.md` (sin endpoint de fills — actualizar), doc oficial Extended API (user/trades)
