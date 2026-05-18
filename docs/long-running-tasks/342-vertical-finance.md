# ccmux Vertical Workflow — Quant Trading & Finance

**Task**: 342 — Finance/quant trading workflow spec
**Date**: 2026-05-18
**Author**: ccmux long-running task #342
**Scope**: Define how a ccmux fleet should be configured to develop and
maintain a quantitative trading codebase: latency-sensitive execution
paths, strategy research, backtests over historical tick data, and
market-data replay harnesses. Documentation only; no source changes to
ccmux itself. Builds on the vertical-workflow conventions in spec 315
(no-PII guardrails, sandbox profiles, gate-driven missions).

---

## 1. Why quant trading needs its own workflow

A trading repo looks superficially like any other Python/C++/Rust
monorepo, but three properties make a generic ccmux configuration the
wrong default:

1. **Hot paths are latency-budgeted in microseconds.** A refactor that
   adds a 200 ns allocation in the order-entry path is a correctness
   regression even if every unit test passes. The agent needs a gate that
   measures latency, not just behaviour.
2. **Strategy code is worthless without a backtest.** Editing
   `strategies/mean_reversion.py` and running `pytest` proves nothing. The
   only meaningful "did this work" signal is a backtest over a frozen
   historical slice, scored against a baseline.
3. **The data is the moat and is often regulated.** Tick data, client
   order flow, and broker confirmations are commercially sensitive at
   best and PII-adjacent at worst. The agent must never read raw client
   identifiers into its context window, ever, even by accident through a
   `grep -r` over the data directory.

The rest of this document is the ccmux configuration that turns those
three properties into mechanical guardrails.

---

## 2. Repo layout assumed by the workflow

```
quant/
  exec/                # C++/Rust hot-path: order entry, risk gates
  strategies/          # Python research code, one module per alpha
  backtest/            # Event-driven backtester (Python core, C++ ext)
  data/
    ticks/             # Parquet, partitioned by symbol/date — DO NOT READ
    reference/         # Symbols, calendars, corporate actions — safe
    replays/           # Recorded ITCH/OUCH binary sessions — DO NOT READ
  bench/               # Microbenchmarks (criterion / google-benchmark)
  tools/
    scrub.py           # PII/PII-adjacent redaction for any data export
```

`data/ticks/` and `data/replays/` are denylisted at the sandbox layer
(section 5). Strategy and backtest code reaches them only through a
narrow Python facade that returns aggregated bars or anonymised event
streams.

---

## 3. `MISSION.md` skeleton for a strategy mission

```markdown
# Mission: <alpha-name> v1 — research → paper trade

## Outcome
A strategy module `strategies/<alpha-name>.py` that:
- Passes the standard backtest suite on 2022-01-01..2024-12-31
- Beats the `flat` baseline on Sharpe AND on max-drawdown
- Has a microbenchmark for its `on_tick` callback under 5 us p99
- Is deployable to the paper-trading account via `make paper`

## Non-goals
- No new dependencies on proprietary vendor SDKs
- No look-ahead bias: only data with `event_time <= decision_time`
- No use of `data/ticks/**` outside the backtester facade

## Constraints
- Python 3.11, numpy 1.26, polars 0.20 pinned in `pyproject.toml`
- Hot path: no Python allocations in steady state (profile with `tracemalloc`)
- All randomness seeded; backtests must be bit-reproducible

## Definition of done
Every task in `tasks.json` reports `status: complete` AND
`make backtest STRATEGY=<alpha-name>` exits 0 AND
`make bench STRATEGY=<alpha-name>` shows p99 <= 5us AND
`make paper STRATEGY=<alpha-name>` enrolls the strategy on the paper
account without compliance warnings.

## Operating notes for the agent
- NEVER open files under `data/ticks/` or `data/replays/` directly.
  Use `from backtest.facade import load_bars, replay_session`.
- NEVER print or log raw account IDs, order IDs, or counterparties.
  The `scrub` helper in `tools/scrub.py` masks them; pipe any debug
  output through it.
- If a backtest shows >5% return per day, assume look-ahead bias and
  STOP — do not "fix" the test to match.
- Latency regressions are real bugs. If `make bench` regresses by
  >10%, set the task `status: blocked` with `blocker: latency-regression`
  rather than tuning the benchmark to hide it.
```

The look-ahead-bias clause is the single most important line. Backtest
returns that look too good are almost always a bug; an agent left to its
own devices will happily "fix" the assertion that was protecting the
human from itself.

---

## 4. `tasks.json` for a strategy mission

```json
{
  "mission": "alpha-research-v1",
  "version": 1,
  "tasks": [
    {
      "id": "hypothesis",
      "title": "Write hypothesis.md: signal, horizon, expected edge",
      "gate": "test -s strategies/<alpha-name>/hypothesis.md",
      "status": "pending"
    },
    {
      "id": "facade-only-scaffold",
      "title": "Strategy module skeleton using backtest.facade",
      "gate": "python -c 'import strategies.<alpha-name>'",
      "depends_on": ["hypothesis"],
      "status": "pending"
    },
    {
      "id": "in-sample-backtest",
      "title": "Backtest 2022-2023 in-sample; record metrics.json",
      "gate": "make backtest STRATEGY=<alpha-name> WINDOW=in-sample",
      "depends_on": ["facade-only-scaffold"],
      "status": "pending"
    },
    {
      "id": "oos-backtest",
      "title": "Backtest 2024 out-of-sample; require Sharpe > baseline",
      "gate": "python tools/check_metrics.py strategies/<alpha-name>/metrics.json --window oos --beats flat",
      "depends_on": ["in-sample-backtest"],
      "status": "pending"
    },
    {
      "id": "replay-validation",
      "title": "Run market-data replay for 3 stress days (2020-03-12, 2024-08-05, 2025-04-09)",
      "gate": "make replay STRATEGY=<alpha-name> SESSIONS=stress",
      "depends_on": ["oos-backtest"],
      "status": "pending"
    },
    {
      "id": "latency-bench",
      "title": "Microbenchmark on_tick, p99 <= 5us",
      "gate": "make bench STRATEGY=<alpha-name> P99_BUDGET_US=5",
      "depends_on": ["replay-validation"],
      "status": "pending"
    },
    {
      "id": "risk-review",
      "title": "Risk file: position limits, kill-switch wiring",
      "gate": "python tools/check_risk.py strategies/<alpha-name>/risk.yaml",
      "depends_on": ["latency-bench"],
      "status": "pending"
    },
    {
      "id": "paper-enroll",
      "title": "Enroll on paper account",
      "gate": "make paper STRATEGY=<alpha-name>",
      "depends_on": ["risk-review"],
      "requires_human": true,
      "status": "pending"
    }
  ]
}
```

Notes worth flagging:

- **`replay-validation` is non-optional.** Backtests use clean,
  aggregated bars; replays push the strategy through raw recorded
  exchange feeds at original timestamps, including the gaps, halts, and
  malformed packets that the bar pipeline smooths away. A strategy that
  passes backtests but crashes on replay is the normal failure mode.
- **`latency-bench` runs after correctness.** Optimising before the
  strategy is right wastes hot-path budget on the wrong code.
- **`paper-enroll` is human-gated.** Even paper trading touches a real
  broker connection and a real compliance log; the agent prepares the PR
  and stops.

---

## 5. Sandbox profile and the no-PII guardrail

Spec 315 introduced per-vertical sandbox profiles. The finance profile
extends the default in three ways:

**Filesystem denylist.** `data/ticks/**` and `data/replays/**` are
unreadable to the agent process. Reads return `EACCES`, which the
backtest facade catches and translates into "use the facade, not raw
paths." The denylist is enforced by the harness, not by convention; an
agent that tries to `cat data/ticks/AAPL/2024-01-02.parquet` gets a hard
fail, not a polite reminder.

**Network egress allowlist.** Only `localhost`, the internal market-data
gateway, and the paper-trading broker endpoint are reachable. Public
internet (including the model API path used by Claude itself) is
mediated through a proxy that strips request bodies of anything matching
the account-ID and order-ID regexes in `tools/scrub.py`. This is the
same scrubber the agent is told to use in `MISSION.md`; defence in depth.

**Tool denylist for log readers.** The harness disables `tail`, `less`,
and raw `grep` against `logs/exec/**`. Execution logs contain
counterparty identifiers that are commercially sensitive even when not
PII per se. The agent reads exec logs through `tools/exec_log.py`, which
returns anonymised, aggregated views.

There is no PII in this workflow because there is no client data in
this workflow — the sandbox makes that statement enforceable rather than
aspirational. Spec 315's central claim is that vertical workflows
should express their data-handling rules as harness configuration, not
as paragraphs in a prompt the model can ignore; the finance profile is
the strictest instance of that pattern.

---

## 6. Market-data replay as a first-class mission artefact

The replay harness deserves more than a one-line gate. It is the
component that gives the agent a tight feedback loop on latency-critical
code without needing access to live markets.

A replay session is a recorded binary capture of an exchange feed (ITCH
for Nasdaq, MDP3 for CME, etc.) with original sub-microsecond
timestamps preserved. `make replay` does three things:

1. Spins up an in-process mock matching engine that consumes the
   capture and emits market-data events to the strategy.
2. Drives the strategy's `on_tick` callback at the original event
   cadence — optionally accelerated, but the timestamps the strategy
   sees are the recorded ones.
3. Compares the strategy's order stream against a recorded "golden"
   order stream for that session, if one exists. Divergence is a
   correctness regression; the diff is surfaced as the gate's stderr so
   the agent can act on it.

The replay corpus is curated rather than exhaustive: three to five
historically interesting sessions (a circuit-breaker day, a quiet
overnight, a heavy options-expiry close) cover most regression classes
that backtests miss. Adding a new replay session is itself a small
mission, with its own `tasks.json` that captures, redacts, and golden-
files a chosen trading day.

---

## 7. How this slots into ccmux

The loop daemon needs no finance-specific code; the workflow is entirely
expressed in three artefacts: the `MISSION.md` charter, the `tasks.json`
gate list, and the sandbox profile that the harness loads when it sees
`vertical: finance` in the repo's `.ccmux/profile.toml`. The same shape
should generalise to adjacent verticals — high-frequency networking,
embedded control, anything where correctness includes a latency budget
and the data is denylisted by default — by swapping the gate commands
and the sandbox denylist while keeping the mission/tasks/profile triple
intact.

The open question this spec leaves for a follow-up is multi-strategy
fleets: when `auto` is running five alpha-research missions in parallel,
how should the shared replay harness and the shared bench machine be
scheduled so that one mission's `make bench` does not skew another
mission's p99 numbers. That is a scheduler problem, not a workflow
problem, and belongs in a separate task.
