// I-097: Central redaction helper for secrets that may end up in logs or
// human-facing diagnostic output (apiKey / authToken / webhookSecret …).
//
// Goal: keep just enough of the value visible to *recognise* it (e.g. confirm
// which key is configured) while never printing it in full. We deliberately
// keep this dependency-free and synchronous so it can be dropped into any
// console.log / error path without ceremony.
//
//   undefined / ""      -> "(unset)"   (distinguishes "not configured" clearly)
//   length <= 4         -> "***"       (too short to reveal anything safely)
//   length  > 4         -> first 2 + "***" + last 2   (e.g. "sk***ef")
//
// The masked form is intentionally lossy: it never reveals the length of the
// secret beyond "short vs long", so it can't be used to narrow a brute force.
export function redactSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "(unset)";
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
