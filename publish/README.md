# Publish

Build scripts for bundling and publishing CodingAgent.

## Files

| Script | npm command | Purpose |
|---|---|---|
| `bundle.mjs` | `npm run bundle` | Bundle all TS into single ESM files via esbuild |
| `smoke-test.mjs` | `npm run test:bundle` | Automated post-bundle smoke tests (runs before every publish) |

---

## `bundle.mjs` — How it works

This script produces the final single-file `dist/index.js` shipped to npm. It uses [esbuild](https://esbuild.github.io/) to bundle all TypeScript source into one ESM file per entry point.

### Entry points

```
src/index.ts              →  dist/index.js
src/gateway/gateway.ts    →  dist/gateway.js
src/gateway/agent-worker.ts → dist/agent-worker.js
```

### The `createRequire` shim (why it's needed)

esbuild injects this banner at the top of the bundle:

```js
import { createRequire as __bundleCreateRequire } from 'module';
const require = __bundleCreateRequire(import.meta.url);
```

**Why:** The project uses `"type": "module"` (ESM), but some bundled CJS dependencies internally use `require()` for Node.js built-ins. ESM doesn't have `require()` natively, so this shim creates one from `import.meta.url`. Without it, any CJS `require('fs')` or `require('path')` inside the bundle would throw `ReferenceError: require is not defined`.

### External packages (why they're excluded)

These packages are marked `external` and NOT bundled:

```js
external: [
  'fsevents',           // macOS-only native module, optional
  'cpu-features',       // Native addon
  'ssh2',               // Native addon (libssh2)
  'bufferutil',         // Native WebSocket addon
  'utf-8-validate',     // Native WebSocket addon
  'playwright',         // Too large (~200MB), installed separately
  'playwright-core',
  '@playwright/test',
  'chromium-bidi',      // Playwright protocol dependency
]
```

**Why:** These are either platform-specific native binaries that can't be bundled into JS, or enormous packages (Playwright) that should be installed independently. Marking them external means they'll be loaded from `node_modules` at runtime if available, and the bundle won't crash if they're absent (they're optional features).

### Optional externals plugin

`onnxruntime-node`, `onnxruntime-web`, and `sharp` are handled by a special `optionalExternalsPlugin` that rewrites their imports as lazy dynamic `import()` calls wrapped in try/catch. This means:

- The app starts normally even if these packages aren't installed
- They're only loaded on-demand when the feature (e.g., transcription) is actually used
- Missing packages produce a clear error at usage time, not at startup

---

## Gotchas & invariants

These are the things that **must** remain true for the build to work:

1. **`format: 'esm'` in esbuild** must match `"type": "module"` in package.json — mixing formats causes Node.js to misparse the file

2. **The `createRequire` shim must exist** — CJS dependencies bundled into ESM need it to call `require()`

3. **ESM imports must be at the top** — Node.js requires `import` statements before any executable code

---

## Testing the build

Smoke tests run **automatically** before every `npm publish` via `prepublishOnly`:

```
npm run clean → npm run bundle → npm run test:bundle → npm publish
```

The tests (`publish/smoke-test.mjs`) check:

1. **All dist files exist** — `dist/index.js`, `dist/gateway.js`, `dist/agent-worker.js` with >1 KB size
2. **ESM imports at the top** — `import` and `const require` lines must appear before any executable code
3. **No SyntaxError** — Node.js can parse the bundles

If any check fails, `process.exit(1)` aborts the publish.

### Running manually

```bash
# Run just the smoke tests (requires dist/ to already exist)
npm run test:bundle

# Full pipeline: clean → bundle → test
npm run clean && npm run bundle && npm run test:bundle
```

### What to check after upgrading dependencies

- **Upgraded `@anthropic-ai/sdk`?** — Check if it still depends on `node-fetch`. If so, ensure `punycode` alias or the npm `punycode` package is present.
- **Upgraded `esbuild`?** — Check the banner format hasn't changed (blank lines, import order).
