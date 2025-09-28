# Plan: Upgrade `mongoose-zod` to Zod 4

## Objectives
- Adopt the Zod 4 runtime and type-level changes without sacrificing existing type guarantees.
- Preserve the current public API surface (including module augmentations) while aligning with Zod 4 idioms.
- IMPORTANT!! DO NOT change things to any or unknown just to pass tests
- Maintain full test coverage and update documentation to reflect the new minimum Zod version.

## References
- Zod 4 changelog on unknown key handling, deprecated object helpers, and new `z.strictObject`/`z.looseObject` APIs.[^1]
- Zod 4 notes on dropped helpers such as `.merge()`, `.strip()`, `ZodEffects`, and new transforms pipeline.[^2]
- Zod 4 API reference for schema definitions, transforms, and metadata access patterns.[^3]

[^1]: https://zod.dev/v4/changelog?id=deprecates-strict-and-passthrough
[^2]: https://zod.dev/v4/changelog?id=drops-zodeffects
[^3]: https://zod.dev/api

## Step 0 — Preparation
- Create a feature branch and capture the current suite status with `npm test`.
- Inventory every Zod import and usage (including `z`, `ZodType`, prototype patching) to understand migration touchpoints.
- Document the baseline behavior of key helpers (`toMongooseSchema`, `addMongooseTypeOptions`, `unwrapZodSchema`) for regression testing.

## Step 1 — Dependency & Tooling Alignment
- Pin both `devDependencies.zod` and the published `peerDependencies.zod` range to the targeted Zod 4 version, ensuring lockfiles are updated.
- Verify TypeScript, ESLint, and ts-jest compatibility with the new Zod types by running type checks after updating `node_modules`.
- Update README and package metadata to communicate the new minimum Zod version.

## Step 2 — Audit Deprecated Object Unknown-Key Helpers
- Replace usages of `.strip()`, `.strict()`, and `.passthrough()` on `ZodObject` instances with the supported Zod 4 alternatives (`z.strictObject`, `z.looseObject`, explicit `setUnknownKeys`).[^1]
- Adjust `unwrapZodSchema` and any other helpers that rely on the legacy `unknownKeys` enum to reflect the updated API surface.
- Revalidate behavior for `UnknownKeysHandling` options (`throw`, `strip`, `strip-unless-overridden`) against the new unknown-key API and add targeted tests where needed.

## Step 3 — Rework Internal `_def` Access
- Review every access to `_def` properties (e.g., `innerType`, `options`, `unknownKeys`, `defaultValue()`, `shape()`) and confirm they still exist or identify the new equivalents in Zod 4.[^3]
- Where possible, replace direct `_def` reads with public helpers (e.g., `schema.shape`, `schema.innerType`, `schema.getDefault()`); if unavoidable, narrow the TypeScript types to match the updated internal definitions to retain type safety.
- Update the module augmentations in `extensions.ts` so the extended methods (`mongoose`, `mongooseTypeOptions`) correctly reflect the new `ZodTypeDef` shape.

## Step 4 — Adjust Effect/Transform Handling
- Update logic that inspects `ZodEffects` (`schema._def.effect`) to work with the new `ZodTransform`/`ZodCheck` pipeline introduced in Zod 4.[^2]
- Ensure refinements, preprocessors, and transforms continue to be unwrapped correctly when generating Mongoose schemas.
- Add regression tests covering schemas that previously relied on `refine`, `transform`, or preprocess behavior.

## Step 5 — Prototype Augmentation Review
- Confirm that attaching helpers to `ZodType.prototype` and `ZodObject.prototype` remains safe in Zod 4; adjust to the new `z.core` namespace if necessary.[^2]
- Re-run linting/type checks to ensure the module augmentations compile with stricter Zod 4 typings and that no `any`/`unknown` regressions are introduced.

## Step 6 — Validate Auxiliary Helpers
- Inspect utilities that special-case `ZodEnum`, `ZodNativeEnum`, `ZodLiteral`, arrays, maps, and dates to ensure their `_def` structures match the Zod 4 definitions.
- Confirm custom type registrations (e.g., `mongooseZodCustomType`) remain accurate, especially for `z.instanceof` and brand handling.
- Revisit error messages thrown via `MongooseZodError` for schemas that now behave differently under Zod 4 (e.g., union handling, nullable/optional inference).

## Step 7 — Regression Testing & QA
- Run `npm run lint`, `npm run lint:types`, and the Jest suite after each migration milestone; fix any new test failures introduced by API changes.
- Add targeted tests that assert the new unknown-keys behavior, transform pipeline expectations, and any newly supported/refined edge cases uncovered during the migration.
- Smoke-test common consumer workflows (creating schemas, applying plugins, lean queries) against a sample Mongoose project using Zod 4.

## Step 8 — Documentation & Release Readiness
- Update examples and API documentation to use the Zod 4 syntax and semantics.
- Highlight migration considerations for downstream users (e.g., requirement to use `z.strictObject` instead of `.strict()`), ideally in `CHANGELOG.md`.
- Once satisfied with coverage and documentation, publish a pre-release (e.g., `0.2.0-beta`) for internal validation before cutting the final release.

