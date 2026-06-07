# ccmux — Issue Triage & Sprint Plan (2026-06-07)

> 15 open issues, all `enhancement`, already priority-labeled. This adds **dependency sequencing** and a **suggested sprint order** so the roadmap can be executed without backtracking. Re-generate with `gh issue list -R thinkyou0714/ccmux`.

## Priority snapshot
| pri | issues |
|---|---|
| high | #15 (`ccmux prune` — impl already exists, just CLI wiring) |
| medium | #12 (daemon log rotation), #13 (HTTPS for `ccmux serve`) |
| low | #2 #3 #4 #5 #7 #8 #10 #11 #14 #16 #17 #38 |

## Dependency graph (do upstream first)
- #3 cost tracking → **#10** budget alert
- #4 `ccmux merge` → **#11** `merge --pr`
- #6 `serve`+auth → **#13** HTTPS
- #8 handoff enhance → **#17** custom template / `--resume`
- #5 `ccmux logs` ↔ **#12** log rotation (sibling)
- #15, #14, #2, #7, #16, #38 — standalone

## Suggested sprint order
1. **Quick wins / foundations** — #15 (`prune`, high, `pruneOrphanedSessions()` already implemented → wire CLI), #14 (`doctor`), #2 (vitest suite — regression safety before further features).
2. **Cost lane** — #3 (per-session cost via ccusage) → #10 (budget alert).
3. **Merge lane** — #4 (`ccmux merge`) → #11 (`merge --pr`).
4. **Ops/handoff lane** — #5 (`ccmux logs`) + #12 (log rotation); #8 (handoff snapshot) → #17 (template/`--resume`).
5. **Platform/polish** — #7 (tmux backend), #13 (HTTPS), #16 (shell completion), #38 (@eslint/js v10 breaking).

## Notes
- #15 is the best first issue: high priority **and** the core logic (`pruneOrphanedSessions()` in `src/core/session.ts`) already exists — it only needs a CLI entry point.
- #2 (tests) should land early; `vitest` is already a devDependency with no tests, so every subsequent feature ships without regression cover until then.
- #38 is dependency-tracking (Renovate/Dependabot driven) — handle when the eslint v10 group PR lands, not ad-hoc.
