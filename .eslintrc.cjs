/**
 * ESLint config for PaintKiDukaan.
 *
 * Note: project does not currently depend on `eslint` (see AGENTS.md: "No ESLint
 * or Prettier configured"). When ESLint is added to devDependencies, also add a
 * TypeScript parser (e.g. `@typescript-eslint/parser`) and set `parser` here —
 * otherwise `.ts`/`.tsx` files fail to parse.
 *
 * Until then, this file exists so the regression guard is defined and reviewable
 * in source control. Run with an explicit --rule override if you need to verify
 * against an externally-installed eslint, e.g.:
 *
 *   pnpm exec eslint src/ \
 *     --rule '{"no-restricted-syntax":[2,{"selector":"CallExpression[callee.property.name='\''invalidateQueries'\'']","message":"Use invalidateList(qc, endpoint) or invalidateListMetrics(qc, endpoint) from src/lib/query/invalidateList.ts instead of raw invalidateQueries"}]}'
 *
 * @type {import('eslint').Linter.Config}
 */
module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  env: { browser: true, es2022: true, node: true },
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
  rules: {
    // Guard: ban raw queryClient.invalidateQueries(...) calls outside the
    // src/lib/query/ helper. The umbrella "use the helper instead" message is
    // enforced; the override below exempts the helper itself.
    //
    // Matches any `something.invalidateQueries(...)` CallExpression. The
    // selector uses the property-name form, so computed access
    // (obj["invalidateQueries"]()) is intentionally not matched.
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.property.name='invalidateQueries']",
        message:
          "Use invalidateList(qc, endpoint) or invalidateListMetrics(qc, endpoint) from src/lib/query/invalidateList.ts instead of raw invalidateQueries",
      },
    ],
  },
  overrides: [
    {
      // Helper file calls invalidateQueries internally — exempt by design.
      files: ["src/lib/query/invalidateList.ts"],
      rules: { "no-restricted-syntax": "off" },
    },
  ],
};
