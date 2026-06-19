// ESLint flat config (eslint 10). Intentionally minimal — tsc already enforces
// type safety, vitest enforces correctness; ESLint is here to catch only the
// cheap-to-fix patterns that tsc doesn't (unused imports, unreachable code,
// no-debugger, etc.) without becoming a treadmill of style rules.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
    },
    rules: {
      // tsc owns this; ESLint's version flags args that ts re-allows via _.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Hooks / heredocs use console.log on purpose for user-facing output.
      "no-console": "off",
      "prefer-const": "warn",
      // We deliberately use `any` in a few cross-platform shim spots
      // (process.exit override in tests, etc.). Warn but don't fail.
      "@typescript-eslint/no-explicit-any": "warn",
      // `?? ""` and `?? 0` short-circuits are correct here.
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
];
