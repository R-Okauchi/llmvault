import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/dist-chrome/**",
      "**/dist-firefox/**",
      "**/node_modules/**",
      "**/coverage/**",
      "packages/keyquill-mobile/ios/**",
      "packages/keyquill-mobile/android/**",
    ],
  },

  // Base JS rules
  js.configs.recommended,

  // TypeScript rules
  ...tseslint.configs.recommended,

  // Override specific rules
  {
    rules: {
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow explicit any in specific cases (zod infer, etc.)
      "@typescript-eslint/no-explicit-any": "warn",
      // No console in production code
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },

  // Node scripts need process/console as globals and are allowed to use
  // console.log for CI output.
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "no-console": "off",
    },
  },

  // Disable formatting rules (Prettier handles formatting)
  eslintConfigPrettier,
);
