import chalk from "chalk";
import ora from "ora";
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { loadConfig } from "../config/schema.js";
import { resolveClaudeCmd } from "../integrations/autoclaw.js";
import { ccmuxDir } from "../core/paths.js";

export interface ReflectOptions {
  apply?: boolean;
  backend?: "claude" | "autoclaw";
  outputFile?: string;
}

const REFLECTION_PROMPT = `You are a meta-learning agent analyzing a Claude Code session log.

Your task: identify patterns, mistakes, and improvements that should be captured as persistent rules.

Instructions:
1. Read the session log below carefully.
2. Identify: what worked well, what failed, what caused repeated retries, what context was missing.
3. Output ONLY a set of concise CLAUDE.md rules (no preamble, no explanation outside the rules).
4. Format each rule as a bullet point under a "## Learned Rules" section header.
5. Rules must be: actionable, specific, generalisable (not session-specific), and under 2 sentences each.
6. Maximum 10 rules. Skip obvious rules already in standard CLAUDE.md defaults.

Session log:
---
`;

export async function reflectCommand(name: string, opts: ReflectOptions): Promise<void> {
  const cfg = await loadConfig();
  const spinner = ora(`Reflecting on session "${name}"...`).start();

  // Find the log file or handoff file
  const logFile = path.join(ccmuxDir(), "logs", `${name}.log`);
  const handoffsDir = path.join(ccmuxDir(), "handoffs");
  let sourceText: string | undefined;
  let sourceLabel = logFile;

  try {
    sourceText = await fs.readFile(logFile, "utf-8");
    sourceLabel = logFile;
  } catch {
    // Fall back to latest handoff file
    try {
      const files = (await fs.readdir(handoffsDir))
        .filter((f) => f.endsWith(`-${name}.md`))
        .sort();
      const latestFile = files[files.length - 1];
      if (latestFile) {
        const latest = path.join(handoffsDir, latestFile);
        sourceText = await fs.readFile(latest, "utf-8");
        sourceLabel = latest;
      }
    } catch {
      // ignore
    }
  }

  if (!sourceText) {
    spinner.fail(chalk.red(`No log or handoff found for session "${name}".`));
    console.log(chalk.dim(`  Looked in: ${logFile}`));
    console.log(chalk.dim(`  Looked in: ${handoffsDir}/*-${name}.md`));
    process.exit(1);
  }

  // Truncate very large logs to last 50K chars to fit context
  const MAX_LOG_CHARS = 50_000;
  if (sourceText.length > MAX_LOG_CHARS) {
    sourceText = `...[truncated — showing last ${MAX_LOG_CHARS} chars]...\n` +
      sourceText.slice(-MAX_LOG_CHARS);
  }

  spinner.text = `Analyzing ${path.basename(sourceLabel)}...`;

  const prompt = REFLECTION_PROMPT + sourceText + "\n---\n";

  // Write prompt to temp file to avoid shell injection
  const tmpPromptFile = path.join(ccmuxDir(), "logs", `.reflect-${name}.tmp`);
  await fs.mkdir(path.dirname(tmpPromptFile), { recursive: true });
  await fs.writeFile(tmpPromptFile, prompt, "utf-8");

  const baseCmd = await resolveClaudeCmd(opts.backend ?? "claude");
  const parsedCmd = parseCmd(baseCmd);
  const claudeBin = parsedCmd[0];
  const claudeExtraArgs = parsedCmd.slice(1);

  const reflection = await runClaudeReflect(
    claudeBin,
    claudeExtraArgs,
    tmpPromptFile,
    opts.backend === "autoclaw" ? cfg.autoclaw.url : undefined
  );

  await fs.unlink(tmpPromptFile).catch(() => {});

  spinner.stop();

  if (!reflection.trim()) {
    console.log(chalk.yellow("  No reflection output received."));
    return;
  }

  console.log(chalk.bold("\nReflection output:"));
  console.log(chalk.dim("─".repeat(60)));
  console.log(reflection);
  console.log(chalk.dim("─".repeat(60)));

  if (opts.outputFile) {
    await fs.writeFile(opts.outputFile, reflection, "utf-8");
    console.log(chalk.green(`\n  Saved to: ${opts.outputFile}`));
    return;
  }

  if (opts.apply) {
    const projectKey = cfg.defaultProject;
    const project = cfg.projects[projectKey];
    if (!project) {
      console.log(chalk.yellow(`  --apply: defaultProject "${projectKey}" not found — cannot auto-apply.`));
      return;
    }
    const claudeMdPath = project.claudeMd ?? path.join(project.path, "CLAUDE.md");
    let existing = "";
    try {
      existing = await fs.readFile(claudeMdPath, "utf-8");
    } catch {
      // CLAUDE.md doesn't exist yet
    }

    const { content: nextContent, replaced } = applyReflectionBlock(existing, reflection);
    await fs.writeFile(claudeMdPath, nextContent, "utf-8");
    console.log(chalk.green(`\n  ${replaced ? "Updated" : "Applied to"}: ${claudeMdPath}`));
    console.log(chalk.dim("  Review with: git diff HEAD CLAUDE.md"));
  } else {
    console.log(chalk.dim("\n  To apply these rules: ccmux reflect " + name + " --apply"));
    console.log(chalk.dim("  To save to file:      ccmux reflect " + name + " --output-file rules.md"));
  }
}

// Sentinels delimiting the ccmux-managed reflection block. Using explicit
// BEGIN/END markers (rather than guessing where an old block ends from a header
// like "## Learned Rules") makes `--apply` idempotent: a second apply replaces
// the prior block in place instead of stacking a duplicate at the end of the
// file. HTML comments are inert in rendered markdown.
export const REFLECT_BLOCK_BEGIN = "<!-- ccmux:reflect:begin -->";
export const REFLECT_BLOCK_END = "<!-- ccmux:reflect:end -->";

/**
 * I-008: build the next CLAUDE.md contents with the reflection block applied
 * idempotently. If a managed block (delimited by the sentinels) already exists,
 * its body is replaced in place; otherwise the block is appended. A legacy
 * block written by older ccmux (the `_Auto-generated by ...` separator without
 * sentinels, always appended at the tail) is detected and migrated/replaced so
 * upgrading users don't accumulate one stale copy.
 *
 * Returns the new file contents and whether an existing block was replaced.
 */
export function applyReflectionBlock(
  existing: string,
  reflection: string,
): { content: string; replaced: boolean } {
  const banner = "_Auto-generated by `ccmux reflect`_";
  const block =
    `${REFLECT_BLOCK_BEGIN}\n\n---\n${banner}\n\n` +
    `${reflection.trim()}\n\n${REFLECT_BLOCK_END}\n`;

  const begin = existing.indexOf(REFLECT_BLOCK_BEGIN);
  const end = existing.indexOf(REFLECT_BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    // Replace the managed block in place, preserving content before/after it.
    const before = existing.slice(0, begin).replace(/\s+$/, "");
    const after = existing.slice(end + REFLECT_BLOCK_END.length).replace(/^\s+/, "");
    const head = before.length > 0 ? `${before}\n\n` : "";
    const tail = after.length > 0 ? `\n${after}\n` : "";
    return { content: `${head}${block}${tail}`, replaced: true };
  }

  // Legacy block (no sentinels): the old code always appended the separator at
  // the tail, so everything from the last separator onward is the generated
  // region — drop it before appending the fresh, sentinel-wrapped block.
  const legacyIdx = existing.lastIndexOf(`---\n${banner}`);
  const base =
    legacyIdx !== -1
      ? existing.slice(0, legacyIdx).replace(/\s+$/, "")
      : existing.replace(/\s+$/, "");
  const sep = base.length > 0 ? "\n\n" : "";
  return { content: `${base}${sep}${block}`, replaced: legacyIdx !== -1 };
}

function parseCmd(cmd: string): [string, ...string[]] {
  // cmd is either "claude" or `ANTHROPIC_BASE_URL="..." claude [--model x]`
  // Strip env var prefix parts (KEY=VALUE), return [binary, ...args]
  const parts = cmd.split(" ");
  const binIdx = parts.findIndex((p) => !p.includes("="));
  return [parts[binIdx] ?? "claude", ...parts.slice(binIdx + 1)];
}

function runClaudeReflect(
  bin: string,
  prefixArgs: string[],
  promptFile: string,
  autoclaUrl?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (autoclaUrl) env["ANTHROPIC_BASE_URL"] = autoclaUrl;

    const args = [...prefixArgs, "--dangerously-skip-permissions", "-p", `@${promptFile}`];
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !out.trim()) {
        reject(new Error(`claude exited ${code}: ${err.trim()}`));
      } else {
        resolve(out.trim());
      }
    });
  });
}
