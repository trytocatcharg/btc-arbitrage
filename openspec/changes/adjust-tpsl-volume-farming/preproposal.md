# Pre-Proposal State — adjust-tpsl-volume-farming

## User-confirmed product decisions (2026-09-07)

1. **BOT PRIMARY OBJECTIVE: farm trading volume.** Not profit maximization. Trades
   only need to be slightly profitable (even cents) or lose very little.
2. **TP/SL cross-symmetry requirement:** the short leg's stop loss must sit at ~the
   same price level as the long leg's take profit, and vice versa (hedged spread
   trade exits on spread convergence/divergence).
3. **TP/SL must be anchored to entry price:** currently observed at ±15% from entry —
   treat as a bug. Exit levels must derive from actual fill prices with a small
   tolerance assertion.
4. **Fee awareness:** opening AND closing commissions must be priced into exit
   targets so a "winning" trade is net-positive after round-trip fees.

## User answers (2026-09-07) — decisiones de producto confirmadas

- D1 Exit model: **solo porcentual** — TP 3% / SL 2.5% por pierna. Se eliminan las
  salidas por spread USD (SPREAD_TP_USD/SPREAD_SL_USD). Se conserva el time-stop
  (timeout) como mecanismo ortogonal de cierre de trades estancados (favorable al
  farming). Requisito transversal: SL del short ≈ TP del long y viceversa (se logra
  anclando ambos al fill price real de cada pierna; ambos venues siguen el mismo
  BTC). "Dejar un margen mínimo para evaluar" la simetría.
- D2 Metas: **dinámico por fees** — breakeven = entry_fees + exit_fees + slippage
  estimado; la evaluación de edge al fill usa breakeven + MIN_PROFIT_USD.
- D3 Volumen: persistir en DB (obligatorio) + resumen Telegram; **dashboard web
  también fue marcado pero junto a "solo DB por ahora" (contradicción)** → se
  propone: DB + Telegram en este change; endpoint web como follow-up marcado en el
  proposal (no-goal o tarea opcional) a confirmar en aprobación del proposal.
- D4 Banda neta: **TP = breakeven + $0.05 mínimo; SL/abort = breakeven − $0.25 máximo.**

## Reconciliación D1 vs D2/D4 (tensión registrada — a validar en explore, a aprobar en proposal)

- Órdenes de salida en pie: TP = fill × (1+3%), SL = fill × (1−2.5%) por pierna,
  ancladas al fill price real (fix del drift ±15%).
- La banda dinámica por fees (breakeven ±) gobierna la **evaluación de edge al
  fill** (reemplaza/extiende OPEN_TRADE_EDGE_MIN_PROFIT_USD): si la convergencia
  esperada < breakeven + $0.05 → cierre inmediato reduce-only (pérdida ≈ fees,
  << $0.25). El SL 2.5% queda como stop catastrófico.
- Modelo final a presentar en proposal para aprobación explícita del usuario.

## Assumptions (no question asked)

- The ±15% drift is a defect to fix within this change, anchored to fill prices.
- "Volume generated" counts filled notional per leg fill (entry + hedge + any
  TP/SL/timeout closes), summed per trade, in USD.
- No new order-placement authority; exits remain reduce-only, bot-only.
- Unit tests remain paused (user instruction); verification is typecheck + dry-run
  evidence.

## Known current behavior (from AGENTS.md — to verify in explore)

- Per-leg TP/SL from `OPEN_TRADE_TAKE_PROFIT_PERCENT` / `OPEN_TRADE_STOP_LOSS_PERCENT` (3/3).
- Spread exits: `OPEN_TRADE_SPREAD_TP_USD` (60), `OPEN_TRADE_SPREAD_SL_USD` (25),
  `OPEN_TRADE_SPREAD_EXIT_TIMEOUT_MINUTES` (30), enforced in trade-monitor.
- Edge validation at fill time: `OPEN_TRADE_EDGE_MIN_PROFIT_USD` (10) vs taker fees + 2bps slippage.
- Fees: risex maker/taker 1/3 bps, extended 0/2.5 bps (config inputs).
