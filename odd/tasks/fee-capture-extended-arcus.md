# Feature: fee-capture-extended-arcus

Fee/PnL real tracking — cerrar el gap de datos crudos detectado en `logs/exchange-responses.jsonl` (2026-10-05/06).

## Contexto

El análisis del log mostró:
- Extended expone `payedFee` (typo incluido) en el payload de orden; el adapter buscaba `fee|totalFee|feeAmount|execFee` → siempre NULL.
- El adapter de Arcus nunca se instrumentó con `logExchangeResponse` → cero eventos de Arcus en el log.
- Arcus REST no tiene fee en órdenes, pero `GET /v1/fills` público expone `fee` y `closedPnl` por fill (ya usado en `resolveClosureFromFills`).

## Tareas

- [x] T1 Extended: agregar `payedFee` a los candidatos de `findDecimal` (getOrder + resolveLegClosure), actualizar comentario
- [x] T2 Arcus: instrumentar `logExchangeResponse` en `arcus-execution-adapter.ts` (order_submit, tpsl_place, order_read fill/terminal, closure_order_read, closure_order_history_read)
- [x] T3 Arcus: exponer `feeUsd`+`realizedPnlUsd` reales en el cierre vía `resolveExitByOrderId` (fills matcheados por exitOrderId); fetchFills extraído y compartido
- [x] T4 Typecheck bot (exit 0)

Sin commit (regla de usuario). Pendiente follow-up: fee de ENTRADA en patas Arcus (hedge market) — se puede capturar igual por orderId desde fills.

## Decisiones

- Fees nunca estimadas: si el exchange no lo reporta, queda `undefined` (convención existente).
- Regla de usuario: NO commitear salvo pedido explícito.
