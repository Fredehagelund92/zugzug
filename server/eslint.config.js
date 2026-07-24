import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "drizzle/migrations"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { Bun: "readonly" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/server.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["./repo.ts", "./repo-*.ts"],
              message:
                "server.ts must not import repo modules directly — use req.repo (TenantRepo). Type-only imports from repo-record are allowed via `import type`.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
);
