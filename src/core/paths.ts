// Phase: 90-pt roadmap (I-030) — single source of truth for HOME / ~/.ccmux
// resolution. These are *functions*, not module-scope constants, so the value
// is read at call time. Capturing env at module load forced every test that
// swaps HOME / CCMUX_DIR to monkey-patch or re-import modules; lazy resolution
// keeps that override window open for the whole process lifetime.

/** Resolve the user home directory (HOME, falling back to USERPROFILE on Windows). */
export function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}

/**
 * Resolve the ccmux state directory (CCMUX_DIR override, else ${HOME}/.ccmux).
 * Uses a literal `/` join — matching the pre-consolidation local helpers — so
 * the exact path string stays stable across platforms and tests.
 */
export function ccmuxDir(): string {
  return process.env.CCMUX_DIR ?? `${home()}/.ccmux`;
}
