# Publish Pipeline

This document explains how CodingAgent is built, bundled, and published to npm.

## Pipeline Overview

```
src/index.ts              ──►  esbuild  ──►  dist/index.js        (single-file, minified)
src/gateway/gateway.ts    ──►  esbuild  ──►  dist/gateway.js      (single-file, minified)
src/gateway/agent-worker.ts ──► esbuild ──►  dist/agent-worker.js (single-file, minified)
```

## Scripts

| Script | Command | Description |
|---|---|---|
| `build` | `npm run build` | TypeScript compile (`tsc`) → multi-file output in `dist/` |
| `bundle` | `npm run bundle` | esbuild bundle → single-file `dist/index.js` (+ gateway, agent-worker) |
| `test:bundle` | `npm run test:bundle` | Automated post-bundle smoke tests |
| `prepublishOnly` | *(automatic)* | Runs `clean` → `bundle` → `test:bundle` → `test:integration` before `npm publish` |
| `clean` | `npm run clean` | Delete the `dist/` folder |

## Bundle (`publish/bundle.mjs`)

Uses [esbuild](https://esbuild.github.io/) to bundle all TypeScript source into **single ESM files**.

**Key settings:**
- `platform: 'node'` / `target: 'node18'` — targets Node.js
- `format: 'esm'` — outputs ES modules (matches `"type": "module"` in package.json)
- `treeShaking: true` — removes unused code
- `minify: true` — standard minification for smaller bundles
- `sourcemap: true` — generates source maps for debugging
- Injects a `createRequire` shim so CJS dependencies using `require()` work in ESM context

**External packages** (not bundled, must be installed at runtime):
- Native/binary modules: `fsevents`, `cpu-features`, `ssh2`, `bufferutil`, `utf-8-validate`
- Playwright: `playwright`, `playwright-core`, `@playwright/test`, `chromium-bidi`

**Optional externals** (lazy-loaded via dynamic `import()` with try/catch):
- `onnxruntime-node`, `onnxruntime-web`, `sharp`
- App starts normally even if these aren't installed; they're loaded on-demand

**Output files:**

| File | Description |
|---|---|
| `dist/index.js` | Main entry (bundled, shipped to npm) |
| `dist/index.js.map` | Source map |
| `dist/gateway.js` | Gateway entry |
| `dist/agent-worker.js` | Agent worker entry |

## Publish

```bash
npm publish
```

The `prepublishOnly` hook automatically runs:
1. `npm run clean` — removes `dist/`
2. `npm run bundle` — bundles with esbuild
3. `npm run test:bundle` — smoke tests
4. `npm run test:integration` — integration tests

Only these files are included in the npm package (via `"files"` in package.json):
- `dist/index.js` + `.map` — main entry
- `dist/gateway.js` + `.map` — gateway entry
- `dist/agent-worker.js` + `.map` — agent worker entry
- `README.md`
- `LICENSE`

## Quick Reference

```bash
# Development (runs TypeScript directly, no build needed)
npm run dev

# Build multi-file JS (for local testing)
npm run build

# Build single-file bundle
npm run bundle

# Clean and publish
npm publish
```
