# Sync Report — adjust-tpsl-volume-farming

- **Status:** synced
- **Change:** `adjust-tpsl-volume-farming` (branch `adjust-tpsl-volume-farming`)
- **Verify verdict:** PASS-WITH-DEFERRED-EVIDENCE (3 runtime evidence items deferred by explicit user decision; these gate archive, not spec sync)
- **User instruction:** "al finalizar, actualiza los spec" (sync specs on completion)
- **Artifact store mode:** openspec (file-backed; `openspec/specs/` was empty — all three capabilities are new)

## What was synced

Canonical specs created from the change's delta specs (delta headers `## ADDED Requirements` converted to plain `## Requirements` sections; all `### Requirement:` and `#### Scenario:` blocks preserved verbatim):

| Capability | Canonical file | Requirements | Scenarios | Source delta |
| --- | --- | --- | --- | --- |
| trade-exits | `openspec/specs/trade-exits/spec.md` | 6 | 15 | `openspec/changes/adjust-tpsl-volume-farming/specs/trade-exits/spec.md` |
| volume-farming | `openspec/specs/volume-farming/spec.md` | 4 | 9 | `openspec/changes/adjust-tpsl-volume-farming/specs/volume-farming/spec.md` |
| volume-stats-api | `openspec/specs/volume-stats-api/spec.md` | 3 | 7 | `openspec/changes/adjust-tpsl-volume-farming/specs/volume-stats-api/spec.md` |

Totals: 13 requirements, 31 scenarios — matching the verify report's coverage counts (13/13 requirements, 31/31 scenarios).

## Delta operations applied

- **ADDED:** all 13 requirements (each new capability carried only `## ADDED Requirements`; no MODIFIED, REMOVED, or RENAMED deltas existed).
- **MODIFIED / REMOVED / RENAMED:** none.

## Guardrails

- **Active same-domain collisions:** none — `openspec/specs/` was empty before this sync; no other active change touches these domains.
- **Destructive sync:** not applicable (pure additive).
- **Legacy flat spec:** none (all three deltas are domain specs).
- **Canonical spec authority:** all writes are inside the workspace at `openspec/specs/<capability>/spec.md`.

## Structured status / actionContext findings

- Change selection: unambiguous — single active change `adjust-tpsl-volume-farming`.
- Verification gate: `verify-report.md` present, verdict PASS-WITH-DEFERRED-EVIDENCE; the 3 deferred items are recorded critical findings gating archive only, not spec sync (explicit user decision recorded in the verify report and parent prompt).
- Delta specs in `openspec/changes/adjust-tpsl-volume-farming/specs/` were **not** modified (delta headers `## ADDED Requirements` retained there, as required).
- A markdownlint autofix (trailing-blank-line cleanup) was applied to the three new canonical files by the editor lens; content otherwise byte-identical to the delta requirements.

## Validation performed

- `openspec validate --specs` → **3 passed, 0 failed** (all three specs valid).
- `openspec list --specs` → trade-exits (6), volume-farming (4), volume-stats-api (3) registered.

## Next recommended phase

- `sdd-archive` — blocked until the 3 deferred runtime-evidence items land (wedged MariaDB server restart required). Spec sync itself is complete and clean; the change folder remains active in `openspec/changes/`.
