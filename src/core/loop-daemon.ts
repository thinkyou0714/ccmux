import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface RunLoopOpts {
  maxIter: number;
  /** Literal substring that signals completion. Matched with .includes(), not regex. */
  untilPattern: string;
  /** Absolute path to log file; opened in append mode. */
  logFile: string;
  /** argv-array for the inner invocation. argv[0] is the binary. */
  claudeArgv: string[];
  /** Scrubbed env passed to both worker and inner invocations. */
  env: Record<string, string>;
  /** Working directory for both worker and inner. */
  cwd: string;
}

/**
 * C-02: detached node worker that drives the loop. Replaces the old bash
 * heredoc in spawnLoopDaemon — no shell-quoted user input anywhere; the
 * worker spawns claude with argv-array (process is invoked directly).
 *
 * Parent returns immediately after spawning the detached worker.
 */
export async function runLoop(opts: RunLoopOpts): Promise<void> {
  // Codex review 2026-05-19: refuse empty untilPattern. .includes("") is
  // always true, which would short-circuit the loop after iteration 1.
  if (typeof opts.untilPattern !== "string" || opts.untilPattern.length === 0) {
    throw new Error("runLoop: untilPattern must be a non-empty string");
  }

  const logHandle = await fs.open(opts.logFile, "a");

  // claudeArgv is small (a binary path + a handful of flags + @promptFile);
  // base64-encode to survive Windows argv quirks while keeping size bounded.
  const argvB64 = Buffer.from(JSON.stringify(opts.claudeArgv), "utf-8").toString("base64");

  const workerScript = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [workerScript, "--worker", String(opts.maxIter), opts.untilPattern, opts.logFile, argvB64],
    {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: opts.env,
    },
  );
  child.unref();
  await logHandle.close();
}

async function workerMain(): Promise<void> {
  const [, , flag, maxIterStr, untilPattern, logFile, argvB64] = process.argv;
  if (flag !== "--worker") {
    console.error("[ccmux loop worker] missing --worker flag");
    process.exit(2);
  }
  // Codex review 2026-05-19: empty pattern guard at the worker too.
  // runLoop() already refuses, but if anyone hand-spawns the worker the
  // guard prevents the same .includes("") infinite-completion bug.
  if (typeof untilPattern !== "string" || untilPattern.length === 0) {
    console.error("[ccmux loop worker] untilPattern must be non-empty");
    process.exit(2);
  }

  const maxIter = parseInt(maxIterStr, 10);
  if (!Number.isFinite(maxIter) || maxIter <= 0) {
    console.error(`[ccmux loop worker] invalid maxIter: ${maxIterStr}`);
    process.exit(2);
  }

  let claudeArgv: string[];
  try {
    claudeArgv = JSON.parse(Buffer.from(argvB64, "base64").toString("utf-8")) as string[];
  } catch {
    console.error("[ccmux loop worker] failed to decode claudeArgv");
    process.exit(2);
  }
  if (!Array.isArray(claudeArgv) || claudeArgv.length === 0) {
    console.error("[ccmux loop worker] claudeArgv must be non-empty array");
    process.exit(2);
  }

  const append = (msg: string): Promise<void> => fs.appendFile(logFile, msg + "\n", "utf-8");

  // Codex review 2026-05-19: only inspect log content WRITTEN BY THIS WORKER.
  // The original `readFile(logFile)` scanned the entire log every iteration,
  // so any past iteration's user prompt or claude output that happened to
  // contain the completion sentinel would short-circuit the loop.
  // Anchor at the byte offset where this run started; per iteration, only
  // examine content added since the previous iteration's check.
  let baselineOffset = 0;
  try {
    baselineOffset = (await fs.stat(logFile)).size;
  } catch {
    baselineOffset = 0;
  }

  for (let i = 1; i <= maxIter; i++) {
    const iterStartOffset = baselineOffset;
    await append(`=== ccmux loop iteration ${i} / ${maxIter} ===`);

    await new Promise<void>((resolve) => {
      const c = spawn(claudeArgv[0], claudeArgv.slice(1), {
        cwd: process.cwd(),
        // env: inherited from parent (already scrubbed at runLoop call site)
        stdio: ["ignore", "inherit", "inherit"],
        // shell: false implied — argv array goes directly to exec.
      });
      c.on("exit", () => resolve());
      c.on("error", (err) => {
        void append(`[ccmux loop] spawn error: ${err.message}`);
        resolve();
      });
    });

    // Read only what was added during this iteration. Use a handle + read
    // to avoid loading the whole log into memory on long runs.
    try {
      const stat = await fs.stat(logFile);
      const newBytes = Math.max(0, stat.size - iterStartOffset);
      let iterContent = "";
      if (newBytes > 0) {
        const fh = await fs.open(logFile, "r");
        try {
          const buf = Buffer.alloc(newBytes);
          await fh.read(buf, 0, newBytes, iterStartOffset);
          iterContent = buf.toString("utf-8");
        } finally {
          await fh.close();
        }
      }
      baselineOffset = stat.size;
      if (iterContent.includes(untilPattern)) {
        await append("=== CCMUX_LOOP_COMPLETE ===");
        return;
      }
    } catch (err) {
      await append(`[ccmux loop] log read error: ${(err as Error).message}`);
    }
  }
  await append("=== CCMUX_LOOP_MAX_ITER_REACHED ===");
}

// Self-invoke as worker only when this file is the entry point.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--worker") {
  workerMain().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ccmux loop worker fatal]", message);
    process.exit(1);
  });
}
