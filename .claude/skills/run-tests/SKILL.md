---
name: run-tests
description: Run the ccmux test suite and typecheck, then summarize failures. Use when asked to test, verify, typecheck, or check a change.
---

Run tests + typecheck and report concisely.

1. Ensure deps are present (SessionStart bootstrap runs `npm ci`; else run it).
2. Tests: `npm test` (→ `vitest run`); single file `npx vitest run <path>`. Typecheck/build: `npm run build` (→ `tsc`).
3. Summarize: total pass/fail, and for each failure the test name + first failing assertion; report any `tsc` type errors with file/line.
4. Do not modify source unless asked.
