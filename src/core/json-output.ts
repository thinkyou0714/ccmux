// I-099: a single structured envelope for every `--json` command so machine
// consumers (n8n, scripts, the shell completions) get a stable, self-describing
// shape instead of N ad-hoc payloads. The contract:
//
//   { schema_version, data, error, warnings, meta }
//
// - schema_version is a string ("1") so a future v2 is a value change, not a
//   type change — consumers can branch on it without a numeric/string surprise.
// - exactly one of data / error is meaningful per response: success sets data
//   and leaves error null; failure sets error and leaves data null.
// - warnings is always an array (never null) so consumers can iterate without a
//   null guard, even on success.
// - meta is an open bag for diagnostic breadcrumbs (command, timestamp, …) that
//   must never be load-bearing for the consumer's happy path.

export interface JsonEnvelope<T> {
  schema_version: "1";
  data: T | null;
  error: string | null;
  warnings: string[];
  meta: Record<string, unknown>;
}

interface EnvelopeOptions {
  warnings?: string[];
  meta?: Record<string, unknown>;
}

// `ts` defaults to "now" but a caller can override it via opts.meta (the spread
// below wins) — handy for deterministic tests.
function baseMeta(command: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { command, ts: new Date().toISOString(), ...extra };
}

export function jsonOk<T>(data: T, opts?: EnvelopeOptions & { command?: string }): JsonEnvelope<T> {
  return {
    schema_version: "1",
    data,
    error: null,
    warnings: opts?.warnings ?? [],
    meta: opts?.command ? baseMeta(opts.command, opts.meta) : (opts?.meta ?? {}),
  };
}

export function jsonErr(error: string, opts?: EnvelopeOptions & { command?: string }): JsonEnvelope<null> {
  return {
    schema_version: "1",
    data: null,
    error,
    warnings: opts?.warnings ?? [],
    meta: opts?.command ? baseMeta(opts.command, opts.meta) : (opts?.meta ?? {}),
  };
}

// stdout, single line, newline-terminated — line-delimited JSON so a consumer
// can read one envelope per line even if a command is ever made to stream.
export function printJson(env: JsonEnvelope<unknown>): void {
  process.stdout.write(JSON.stringify(env) + "\n");
}
