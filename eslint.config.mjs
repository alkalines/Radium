import { defineConfig, globalIgnores } from "eslint/config";
import { tanstackConfig } from "@tanstack/eslint-config";
import convexPlugin from "@convex-dev/eslint-plugin";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  ...tanstackConfig,
  ...convexPlugin.configs.recommended,
  {
    files: ["**/*.{js,jsx,ts,tsx,mjs,mts}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/method-signature-style": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@stylistic/spaced-comment": "off",
      "import/consistent-type-specifier-style": "off",
      "import/order": "off",
      "prefer-const": "warn",
      "sort-imports": "off",
    },
  },
  globalIgnores([
    ".next/**",
    ".output/**",
    "out/**",
    "build/**",
    ".agents/**",
    "convex/_generated/**",
    "src/routeTree.gen.ts",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
