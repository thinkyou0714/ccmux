import { InvalidArgumentError } from "commander";

/**
 * Commander option-argument parser for integers.
 *
 * Replaces passing `parseInt` directly as a coercion. Commander invokes a
 * coercion as `fn(value, previousValue)`, so `parseInt` was being called as
 * `parseInt("8", 50)` — the previous/default value silently became the radix,
 * yielding NaN (or worse, a misparse) for any option that has a default or is
 * supplied more than once. This wrapper takes only the string value, validates
 * it strictly, and enforces optional inclusive [min, max] bounds.
 *
 * @param min Inclusive lower bound (optional).
 * @param max Inclusive upper bound (optional).
 * @returns A commander-compatible coercion `(value, previous?) => number`.
 */
export function intArg(
  min?: number,
  max?: number,
): (value: string, previous?: unknown) => number {
  return (value: string, _previous?: unknown): number => {
    if (!/^-?\d+$/.test(value)) {
      throw new InvalidArgumentError("Expected an integer.");
    }
    const n = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(n)) {
      throw new InvalidArgumentError("Number is too large.");
    }
    if (min !== undefined && n < min) {
      throw new InvalidArgumentError(`Must be >= ${min}.`);
    }
    if (max !== undefined && n > max) {
      throw new InvalidArgumentError(`Must be <= ${max}.`);
    }
    return n;
  };
}
