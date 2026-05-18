# ccmux Mission Template — Rust Crate Development

**Task**: 244 — Mission template for Rust crate development
**Date**: 2026-05-18
**Author**: ccmux long-running task #244
**Scope**: Provide a reusable `MISSION.md` + `tasks.json` pair that a ccmux
agent can drop into a new repository to drive a Rust crate from `cargo new`
through API design, tests, docs.rs preview, and a `crates.io` publish.
No source modifications; documentation only.

---

## 1. Why a Rust-crate-shaped template

ccmux missions tend to be long horizon: a single agent (or a small fleet
under `auto`) iterates over dozens of edit-build-test cycles, and the
bottleneck is rarely "can Claude write Rust" — it is "does the agent know
when it is done, and in what order to attempt the next step." Rust crate
publishing is a near-ideal mission shape because the success criteria are
mechanically checkable at every phase: `cargo check`, `cargo test`,
`cargo doc`, `cargo publish --dry-run`. A mission template that encodes
those gates lets the agent self-evaluate without a human in the loop, which
is exactly what the `auto` daemon needs.

This template assumes the conventions already used elsewhere in ccmux:
`MISSION.md` is a human-readable charter that the agent re-reads on every
session start, and `tasks.json` is the machine-readable task list the
loop driver iterates. Both live at the repo root of the *target* crate, not
in ccmux itself.

---

## 2. `MISSION.md` skeleton

```markdown
# Mission: <crate-name> v0.1.0 → crates.io

## Outcome
A published `<crate-name>` crate on crates.io with:
- Stable, documented public API (`#![deny(missing_docs)]`)
- >= 80% line coverage from `cargo test`
- Green docs.rs build (no broken intra-doc links)
- CI on stable + MSRV pinned in `Cargo.toml`
- `CHANGELOG.md` following Keep-a-Changelog

## Non-goals
- No async runtime lock-in (feature-gate `tokio`/`async-std` if needed)
- No unsafe code in v0.1 unless justified in `SAFETY.md`
- No breaking deps on nightly

## Constraints
- MSRV: 1.75
- License: MIT OR Apache-2.0 (dual)
- Edition: 2021 (revisit 2024 at v0.2)

## Definition of done
Each phase in `tasks.json` reports `status: complete` AND
`cargo publish --dry-run` exits 0 AND the crate name is reserved on
crates.io under the configured owner.

## Operating notes for the agent
- Use `cargo add`/`cargo remove` rather than hand-editing `[dependencies]`.
- Never commit `Cargo.lock` for a library crate.
- Run `cargo fmt && cargo clippy --all-targets -- -D warnings` before any
  commit; the pre-commit hook will reject otherwise.
- If a task is blocked on a human (e.g. crates.io owner invite), set
  `status: blocked` with a `blocker` field and stop — do not invent
  credentials.
```

The charter is deliberately short. Anything longer gets ignored by the
agent after the second session because the context window prioritises
recent tool output. The "Operating notes" block is the part that earns
its keep: it is the agent's runtime contract.

---

## 3. `tasks.json` skeleton

```json
{
  "mission": "rust-crate-v0.1",
  "version": 1,
  "tasks": [
    {
      "id": "scaffold",
      "title": "cargo new --lib and baseline metadata",
      "gate": "cargo check",
      "artifacts": ["Cargo.toml", "src/lib.rs", "README.md", "LICENSE-*"],
      "status": "pending"
    },
    {
      "id": "api-sketch",
      "title": "Draft public API in src/lib.rs with doc comments only",
      "gate": "cargo doc --no-deps",
      "depends_on": ["scaffold"],
      "status": "pending"
    },
    {
      "id": "impl",
      "title": "Implement API behind the doc comments",
      "gate": "cargo build --all-features",
      "depends_on": ["api-sketch"],
      "status": "pending"
    },
    {
      "id": "tests",
      "title": "Unit + doctests + one integration test in tests/",
      "gate": "cargo test --all-features",
      "coverage_min": 0.80,
      "depends_on": ["impl"],
      "status": "pending"
    },
    {
      "id": "lint",
      "title": "clippy --all-targets -D warnings; fmt clean",
      "gate": "cargo clippy --all-targets -- -D warnings && cargo fmt --check",
      "depends_on": ["tests"],
      "status": "pending"
    },
    {
      "id": "docs-rs-preview",
      "title": "Local docs.rs-shaped build, fix intra-doc links",
      "gate": "RUSTDOCFLAGS='-D warnings' cargo doc --no-deps --all-features",
      "depends_on": ["lint"],
      "status": "pending"
    },
    {
      "id": "ci",
      "title": "Add .github/workflows/ci.yml: stable + MSRV matrix",
      "gate": "actionlint .github/workflows/ci.yml",
      "depends_on": ["docs-rs-preview"],
      "status": "pending"
    },
    {
      "id": "changelog",
      "title": "Write CHANGELOG.md 0.1.0 entry; bump Cargo.toml version",
      "gate": "grep -q '^## \\[0.1.0\\]' CHANGELOG.md",
      "depends_on": ["ci"],
      "status": "pending"
    },
    {
      "id": "dry-run",
      "title": "cargo publish --dry-run --allow-dirty=false",
      "gate": "cargo publish --dry-run",
      "depends_on": ["changelog"],
      "status": "pending"
    },
    {
      "id": "publish",
      "title": "cargo publish (requires CARGO_REGISTRY_TOKEN)",
      "gate": "cargo search <crate-name> | grep -q '^<crate-name> = \"0.1.0\"'",
      "depends_on": ["dry-run"],
      "requires_human": true,
      "status": "pending"
    }
  ]
}
```

Two design decisions worth flagging:

**`gate` is a shell command, not a free-form description.** The loop driver
runs it verbatim and treats exit 0 as "advance". This removes the
LLM-judges-LLM failure mode where the agent decides a phase is done because
it *thinks* tests pass.

**`requires_human: true` short-circuits `auto`.** The publish step needs a
real `CARGO_REGISTRY_TOKEN` and an owner on crates.io; the daemon should
park the mission and surface a notification rather than fabricate
credentials or skip the gate.

---

## 4. Phase-by-phase notes the agent will actually need

**scaffold.** Use `cargo new --lib --vcs=none` (the worktree already has
git); set `edition`, `rust-version`, `license`, `repository`, `description`,
`keywords` (max 5), `categories` (max 5) in `Cargo.toml`. Missing keywords
is the most common reason a first publish gets rejected.

**api-sketch.** Write the public surface as `pub fn`/`pub struct` with
`todo!()` bodies and full rustdoc, including `# Examples` blocks. Doctests
will fail until `impl` — that is intentional and gives the next phase its
target.

**impl.** Replace `todo!()`. Resist adding new public items not in the
sketch; if a new item is needed, go back to `api-sketch` and update the
sketch first so the doctests stay the spec.

**tests.** Three buckets: unit tests inline (`#[cfg(test)] mod tests`),
doctests (already drafted), and at least one `tests/smoke.rs` integration
test that consumes the crate the way a downstream user would. Coverage
gate is advisory; if `cargo-llvm-cov` is unavailable, skip the numeric
check but keep the artifact.

**lint.** Clippy with `-D warnings` is non-negotiable for a published
crate; fixing clippy after publish is a breaking-change minefield.

**docs-rs-preview.** docs.rs builds with `--all-features` on a specific
toolchain. Mimic it locally with `RUSTDOCFLAGS='-D warnings'` so broken
intra-doc links fail loudly. Add a `[package.metadata.docs.rs]` block if
the crate has feature-gated items.

**ci.** Minimum: build + test on stable and on the MSRV pinned in
`rust-version`. Add `cargo deny check advisories` if the crate has any
non-trivial dep tree.

**changelog.** First entry is `## [0.1.0] - <date>` with an `### Added`
section. Subsequent missions can reuse this template by bumping the
version and appending a new heading.

**dry-run.** This catches missing `description`, `license`, oversized
package (>10 MB), and uncommitted files. Treat any warning as a failure
for v0.1.

**publish.** Human-gated. The agent's job is to print the exact command
and the expected post-publish verification (`cargo search`), then stop.

---

## 5. How this slots into ccmux

The loop daemon already knows how to walk a `tasks.json` and run a `gate`
per task; the Rust template is just a populated instance of that schema.
Dropping these two files into a fresh repo and pointing `auto` at it
should drive an empty directory to a published crate with no further
prompting, modulo the human-gated publish step. The same shape generalises
to other publish targets — npm, PyPI, Homebrew — by swapping the gates,
which is the next template worth writing.

