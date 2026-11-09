# Feature: Tests de caminos críticos de trading (BTC + metales)

**Estado:** en progreso
**Pedido por:** operador (2026-XX, reactiva la pausa de unit tests de 2026-08-16)
**Branch:** main

## Objetivo

Cubrir con tests unitarios los caminos críticos de órdenes/trades:

- **BTC**: poner órdenes, abrir y **cerrar** trade.
- **Metales (GOLDSILVER)**: poner órdenes, abrir y **cerrar** trade.

**Fuera de foco** (explícito del operador): seteo de variables/config,
volumen, listado de trades activos.

Sin cambios a código de producción salvo que un test exponga un bug real
(consultar antes).

## Convenciones de test

- `node:test` + `node:assert/strict`, corridos con `tsx` importando fuente.
- Estilo del harness existente en `apps/bot/test/open-trade.test.ts`:
  `fakeAdapter()` (execution mock con `calls[]`), `registry()`, `memoryStore()`.
- Comando por workspace: `node --import tsx --test test/**/*.test.ts` (desde
  `apps/bot`). Typecheck: `yarn typecheck` desde la raíz.
- ⚠️ El operador pide recordarle correr los tests tras cada cambio.

## Tareas

### 1. BTC close — `apps/bot/test/trade-close.test.ts`
Cubre `closeTradeBothLegs` (`src/trading/trade-close.ts`):
- [ ] Cancela los backstops TP/SL de ambas patas (ids tomados de `leg.raw`).
- [ ] Cierra con reduce-only market por pata (lado correcto: long→sell, short→buy).
- [ ] Espera flat; persist de legs `closed` + trade `closed` con PnL GROSS
      derivado (entry/exit/qty) y `close_reason`.
- [ ] Pata que no confirma flat → leg `unhedged` + trade `unhedged` (close_failed).
- [ ] Falla del persist final → notify urgente con outcomes (la pre-persist
      `closing` queda).
- [ ] `formatPnlColored` signos.

### 1b. Suite usable — arreglar tests viejos (sin esto `yarn test` no corre)
Diagnóstico propio (reproducido en HEAD sin cambios nuevos):
- [ ] `risex-execution-adapter.test.ts` "reduce-only market close" cuelga:
      `waitForMarketFill` con `fixedNow` nunca vence deadline y el fake de
      `/v1/account/position` nunca refleja el fill. Fix: el fake debe sumar
      la cantidad del market order a la posición luego del POST.
- [ ] `open-trade.test.ts` 2 tests esperan TP/SL sobre precio (110000);
      desde 2026-09-21 es sobre margen (10%/3 → 103333.33). Actualizar
      expectativas a la semántica margin-based documentada.
- [ ] `trade-summary.test.ts`: regex espera `Estimated PnL:`, el mensaje
      actual dice `Trade estimated PnL:` / `Global estimated PnL:`.

### 2. Metal entry — `apps/bot/test/metal-trade-entry.test.ts`
Cubre `createMetalTrade` + `executeMetalTradeEntry`
(`src/metal-ratio/metal-trade-service.ts`) con fake Arcus (execution adapter
con `getOrderBookDepth`) y mini-fake de drizzle en memoria:
- [ ] Order-book gate: rechaza cuando el drag estimado supera
      `GOLDSILVER_MAX_ENTRY_SLIPPAGE_BPS`; sin `getOrderBookDepth` rechaza;
      libro fino rechaza; nada se persiste en rechazo.
- [ ] Sizing dollar-neutral: goldQty < silverQty para el mismo notional.
- [ ] `createMetalTrade` inserta trade `executing_limit` + 2 legs `planned`
      (mercados GLD/SLV en `raw`), historial de estado.
- [ ] `executeMetalTradeEntry`: limit post-only ALO en GLD al toque +1 tick;
      hedge IOC en SLV por incremento de fill; rechazo post-only re-clampa.
- [ ] Hedge IOC zero-fill → re-bound + retry acotado; retries agotados →
      rollback market-close de lo cubierto en GLD.

### 3. Metal close — `apps/bot/test/metal-trade-close.test.ts`
Cubre `closeMetalTrade` (`mode: "market"`, y camino límite del TP si entra
en presupuesto):
- [ ] Cancela disaster stops de ambas patas antes de cerrar.
- [ ] Market reduce-only por pata con lado de cierre correcto; poll terminal;
      legs `closed` con exit price/fee/PnL gross; trade `closed` con
      realized/total_fees/filled_notional; notify con Gross/Fees/Net.
- [ ] Carrera de claim: trade ya `closing`/`closed` → no-op sin órdenes.
- [ ] (Si aplica) modo límite: dual limits resting + fallback a market del
      remanente al agotar presupuesto de repricing.

## Evidencia

- Tarea 1 (BTC close): `test/trade-close.test.ts`, 7 tests, suite 50/50, typecheck 0. (sin commit — el operador no pidió commits)
- Tarea 1b (suite usable): fixes en `risex-execution-adapter.test.ts` (fake stateful del fill; stop_price_option MARK_PRICE; priceTickUsd), `open-trade.test.ts` (TP/SL margin-based), `trade-summary.test.ts` (regex copy actual). Suite 50/50.
- Tarea 2 (metal entry): `test/metal-trade-entry.test.ts` + `test/helpers/fake-drizzle.ts`, 14 tests, suite 64/64, typecheck 0.
- Tarea 3 (metal close): `test/metal-trade-close.test.ts`, 7 tests, suite 71/71, typecheck 0.
- Silencio de `RISEx market fill poll` bajo NODE_ENV=test (script `test` del bot la define).

## Hallazgos de producción (NO arreglados — decisión del operador)

1. ~~**Entry — fuga de oro en abort por hedge retries agotados**~~ **FIXED**:
   `hedgeIncrement` ahora acredita `progress.goldFilledQty` ANTES de
   lanzar el hedge, así que `abortEntry` market-cierra el oro cubierto en
   todo throw path (BBO, mínimo SLV, retries agotados, precio faltante).
   Test `exhausted hedge retries…` actualizado a la conducta correcta.
2. **Close — pérdida de datos en patas ya cerradas**: `finalizeClosedTrade` reescribe TODAS las patas; una pata cerrada por el monitor (trade `unhedged`) queda `failed`, con exit price anulado y PnL en 0 — pisa el registro del monitor y el PnL del trade la excluye silenciosamente. **Pendiente decisión del operador.**
3. **Close (limit mode) — límite restante sin cancelar**: el fallback a market por presupuesto agotado no cancela el reduce-only limit que sigue resting en Arcus. **Pendiente decisión del operador.**

Tests 2 y 3 codifican el comportamiento actual con comentarios KNOWN BUG/GAP.

## Notas

- La pausa de unit tests (2026-08-16, AGENTS.md) queda **levantada** por
  pedido explícito del operador.
- El mini-fake de drizzle debe soportar `select/from/where/limit`,
  `insert/values`, `update/set/where` con `affectedRows`/`insertId`
  (vía `extractAffectedRows`/`extractInsertId`), y `transaction(fn)`.
  Las condiciones `and(eq(...))` necesitan un evaluador mínimo sobre los
  `queryChunks` de drizzle para el claim race-safe de `transitionTrade`.
