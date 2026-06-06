# ccmux — Issue Triage

> Auto-triaged via the `issue-triage` skill (Impact × Effort × Urgency).
> 17 open issues, all `enhancement` (feature requests) — 0 bugs, 0 close-recommended.
> Priority labels are applied on each issue.

## Priority

| Priority | Issues |
|---|---|
| **high** | #6 (security: `serve` webhook token auth) · #9 (ci: lint+test+build) · #15 (prune orphaned sessions) |
| **medium** | #13 (security: `serve` HTTPS/TLS) · #12 (daemon log rotation) |
| **low** | #2–#5, #7, #8, #10, #11, #14, #16, #17, #38 |

## Sprint 1 (recommended, ~8pt cap)

Order: **#6 → #9 → #15 → #13 → #12**

- Lead with **security (#6** webhook token auth**)** + **CI (#9** lint/test/build automation**)**.
- **#13** (`serve` HTTPS) touches the same `n8n.ts` / serve path as #6 → bundle in the same sprint.
- **#15** (`pruneOrphanedSessions()` already implemented) is XS effort, high impact.

_Generated 2026-06-06 during the THINK YOU LAB GitHub remediation pass._
