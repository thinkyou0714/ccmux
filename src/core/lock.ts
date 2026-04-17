import fs from "fs/promises";
import path from "path";

const CCMUX_DIR = process.env.CCMUX_DIR ?? `${process.env.HOME}/.ccmux`;
const LOCKS_DIR = path.join(CCMUX_DIR, "locks");

function lockPath(name: string): string {
  return path.join(LOCKS_DIR, `${name}.lock`);
}

export async function acquireLock(name: string): Promise<void> {
  await fs.mkdir(LOCKS_DIR, { recursive: true });
  const lp = lockPath(name);

  try {
    // Exclusive creation — fails if file already exists
    await fs.writeFile(lp, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (err: unknown) {
    // Check if the locking PID is still alive
    try {
      const existing = await fs.readFile(lp, "utf-8");
      const pid = parseInt(existing, 10);
      try {
        process.kill(pid, 0);
        throw new Error(`Session "${name}" is already running (PID: ${pid})`);
      } catch (killErr: unknown) {
        const isEsrch = (killErr as NodeJS.ErrnoException).code === "ESRCH";
        if (isEsrch) {
          // Stale lock — remove and retry
          await fs.unlink(lp);
          await fs.writeFile(lp, String(process.pid), { flag: "wx", mode: 0o600 });
        } else {
          throw killErr;
        }
      }
    } catch (innerErr: unknown) {
      const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      if (msg.includes("already running")) throw innerErr;
      throw err;
    }
  }
}

export async function releaseLock(name: string): Promise<void> {
  try {
    await fs.unlink(lockPath(name));
  } catch {
    // Already gone — ignore
  }
}

export async function isLocked(name: string): Promise<boolean> {
  try {
    await fs.access(lockPath(name));
    return true;
  } catch {
    return false;
  }
}
