# Strategy-Improvement Agent — Roadmap

Status: active — phase 1 (observability) implemented on branch
`feat/unhedged-observability` (commit `046ac50`), pending deploy + push.
Last updated: 2026-10-09.

## Goal

Build an offline agent that analyzes closed/open trades and continuously
proposes evidence-backed improvements to the exit strategy, so an **unhedged
window** (one leg's TP/SL fired, sibling still open) stops being an
uncontrolled loss. The agent improves *parameters and policies*, never the
live order path.

## Hard guardrails (operator decisions)

- **The LLM never sits in the live order path.** All runtime decisions stay in
  the deterministic bot code (`apps/bot/src/trading/`). Trading safety model
  unchanged: no order without explicit Telegram confirmation (or the explicit
  `OPEN_TRADE_AUTO_CONFIRM` opt-in).
- **The agent proposes, the operator approves.** Every improvement enters as a
  reviewed change (OpenSpec/ODD workflow), never auto-applied.
- **"Learning" happens in backtest, not in production.** Candidate policies
  are replayed against historical trades + spread paths before any proposal.
- Backend and web stay read-only; no mutating endpoints.

## Architecture — three layers

1. **Observability** — what the agent sees. Trade timelines, unhedged windows
   (start/end/duration/PnL), decision events. Mostly served by read-only
   backend APIs over MariaDB.
2. **Policy engine** — deterministic, versioned exit strategies with
   configurable parameters. Candidates for the unhedged problem: trailing stop
   on the surviving leg, breakeven SL on the sibling at first-leg closure,
   immediate reduce-only close (lock PnL), hedge-on-retrace (wait for spread
   to reopen). The bot executes one configured policy; the agent proposes
   parameter/policy diffs.
3. **Analysis loop (offline agent)** — export → analyze → backtest → propose.
   Runs as a Pi subagent against the backend APIs; findings persist in Engram
   memory; proposals are repo changes reviewed by the operator.

## Execution models for the agent (operator chose flexibility)

- **On demand**: launched from a Pi session whenever the operator wants.
  Nothing runs unattended.
- **Scheduled**: cron/Portainer job on the server where the bot DB lives;
  e.g., a weekly report. No operator PC required.
- **Telegram**: as *trigger and inbox only* — a command fires the job or the
  bot delivers a generated report. Never as an in-process decision maker.

## Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| 1. Unhedged observability APIs + monitor history instrumentation | Implemented (046ac50) | `GET /api/trades/unhedged/active`, `/api/trades/unhedged/events`, `/api/trades/:id/timeline`; monitor writes `trade_status_history`. Needs backend+bot rebuild/restart to take effect. Pre-deploy unhedged trades are `approximateStart: true`. |
| 2. Unrealized-PnL sampling during unhedged windows | Not started | Bot tick must sample mark-to-market of the surviving leg while `unhedged` (new table or reuse `trade_status_history.metadata`); without it we measure only final outcomes, not intra-window drawdown. |
| 3. Decision-event logging | Not started | Structured event per guardrail decision (`spread_dropped`, anti-chase abort, `edge_below_cost`) with the numbers that motivated it. The `events` table exists but has no writers — candidate sink. |
| 4. Offline analysis agent (export → metrics → report) | Not started | Consumes phase 1-3 data; weekly or on-demand; writes `odd/` proposals. |
| 5. Backtest/replay harness for exit policies | Not started | Replay candidate policies against historical unhedged events + spread paths before proposing. Guards against overfitting a handful of trades. |
| 6. Policy engine in bot (config-versioned exit strategy) | Not started | Only after phase 5 evidence. |

## What the agent needs from the operator

- Read-only DB access (or the backend base URL) for the environment where it
  runs.
- Approval of each proposed change; push/deploy of the bot and backend.

## Key data conventions

- `realized_pnl_usd` columns are GROSS (fee-free); net = realized −
  `total_fees_usd`; NULL fees are never estimated.
- Unhedged window derivation: `trade_status_history` rows with
  `to_status='unhedged'` (written by the monitor since `046ac50`) mark the
  start; the earliest later `closed`/`failed` row marks the end. See
  `specs/backend.md` section 4.
