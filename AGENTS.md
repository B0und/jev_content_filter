# Repository guidance

This is an npm-managed WXT/React browser extension. Preserve the generated `.wxt/tsconfig.json` inheritance. Run `npm run compile` for TypeScript types, `npm run lint` for existing lint rules and Effect diagnostics, `npm test` for unit tests, and `npm run build` for the extension build. `npm run check` runs these checks plus formatting and browser tests. Typechecking alone does not enforce Effect-specific rules.

## Effect reference workflow

This repository uses Effect v4 release candidates. Use the installed package as the primary reference so guidance matches the lockfile:

1. Before writing Effect code, read `node_modules/effect/AGENTS.md` completely.
2. Follow its relevant links to bundled documentation and examples.
3. Search `node_modules/effect/src` for public API signatures, JSDoc, and implementations when needed. Internal implementation techniques are not automatically suitable application patterns.
4. Verify usage with both `npm run compile` and `npm run lint`.

Prefer installed documentation and source when references differ. Import Schema from `effect/Schema`.
