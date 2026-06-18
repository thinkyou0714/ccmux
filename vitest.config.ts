import { defineConfig } from "vitest/config";

// I-055: pin vitest's previously-implicit configuration so behaviour doesn't
// drift with vitest defaults and isn't smeared across shell globs in CI.
//
// IMPORTANT (CI contract): the root `npm test` (= `vitest run`) must exclude the
// integration suite, while `npm test -- tests/integration` (run as a separate CI
// step) must still run it. vitest applies `exclude` even when an explicit
// positional path is given, so putting `tests/integration/**` in `exclude` here
// would make the integration step match zero files. We therefore keep `exclude`
// at the defaults only, and let CI's existing `--exclude "tests/integration/**"`
// flag (ci.yml "Unit tests" step) carve integration out of the unit run. That
// keeps both `npm test` and `npm test -- tests/integration` working as before
// while still fixing the timeout/defaults under a checked-in config.
export default defineConfig({
  test: {
    // Longer than vitest's 5s default: integration tests spawn a stub HTTP
    // server and drive the CLI, and Windows CI runners are slow. 20s gives
    // headroom without masking genuine hangs.
    testTimeout: 20000,
    // No coverage threshold gate here — that is tracked separately.
  },
});
