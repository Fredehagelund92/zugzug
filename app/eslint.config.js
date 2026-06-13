import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-restricted-syntax": ["error",
        {
          selector: "CallExpression[callee.name='fetch'] > Literal[value=/^\\/api/]",
          message: "Use apiFetch() from src/api.ts — raw fetch bypasses tenant routing.",
        },
        {
          selector: "CallExpression[callee.name='fetch'] > TemplateLiteral[quasis.0.value.raw=/^\\/api/]",
          message: "Use apiFetch() from src/api.ts — raw fetch bypasses tenant routing.",
        },
        {
          selector: "NewExpression[callee.name='Request'] > Literal[value=/^\\/api/]",
          message: "Use apiFetch() from src/api.ts — raw Request() bypasses tenant routing.",
        },
        {
          selector: "NewExpression[callee.name='Request'] > TemplateLiteral[quasis.0.value.raw=/^\\/api/]",
          message: "Use apiFetch() from src/api.ts — raw Request() bypasses tenant routing.",
        },
      ],
      "no-restricted-imports": ["error", { paths: ["axios", "ky"] }],
    },
    settings: { react: { version: "detect" } },
  },
  {
    files: ["src/api.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
