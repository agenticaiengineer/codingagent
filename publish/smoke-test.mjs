#!/usr/bin/env node
/**
 * Post-bundle smoke tests — runs automatically before `npm publish`.
 *
 * Validates that the build output is structurally correct:
 *  1. dist/index.js, dist/gateway.js, dist/agent-worker.js exist with reasonable size (>1KB)
 *  2. ESM import statements are at the top of each bundle (before any executable code)
 *  3. Node.js can parse each bundle without SyntaxError
 *
 * See publish/README.md for background on why each check matters.
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  failed++;
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
}

// ── Test 1: Required files exist with reasonable size ──────────────────────

console.log('\n🔍 Checking build outputs…');

const requiredFiles = [
  { path: 'dist/index.js', label: 'Bundle (index)' },
  { path: 'dist/gateway.js', label: 'Bundle (gateway)' },
  { path: 'dist/agent-worker.js', label: 'Bundle (agent-worker)' },
];

for (const { path: rel, label } of requiredFiles) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    fail(`${label} exists (${rel})`, 'File not found');
    continue;
  }
  const size = statSync(abs).size;
  if (size < 1000) {
    fail(`${label} has content (${rel})`, `Only ${size} bytes — likely empty or corrupt`);
    continue;
  }
  ok(`${label} exists — ${(size / 1024).toFixed(0)} KB`);
}

// ── Test 2: ESM imports are at the top of each bundle ─────────────────────

console.log('\n🔍 Checking ESM import placement…');

for (const { path: rel, label } of requiredFiles) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    fail(`${label}: Import placement check`, `${rel} not found — skipped`);
    continue;
  }

  const code = readFileSync(abs, 'utf-8');
  const lines = code.split('\n');

  let foundImport = false;
  let foundCode = false;
  let importAfterCode = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#!')) continue;

    if (/^import\s/.test(trimmed) || /^const\s+require\s*=/.test(trimmed)) {
      if (foundCode) {
        importAfterCode = true;
        break;
      }
      foundImport = true;
    } else {
      foundCode = true;
    }
  }

  if (!foundImport) {
    fail(`${label}: Import statements present`, 'No import or const require found at top of file');
  } else if (importAfterCode) {
    fail(`${label}: Imports before code`, 'import/require line found AFTER executable code');
  } else {
    ok(`${label}: ESM imports are correctly placed at the top`);
  }
}

// ── Test 3: Node.js can parse each bundle without SyntaxError ─────────────

console.log('\n🔍 Checking Node.js can parse the bundles…');

for (const { path: rel, label } of requiredFiles) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    fail(`${label}: Syntax check`, `${rel} not found — skipped`);
    continue;
  }

  // Dynamic import from disk — avoids ENOBUFS from piping a large file via stdin.
  // We only care about SyntaxError; runtime errors (missing env vars, etc.) are fine.
  const fileUrl = 'file:///' + abs.replace(/\\/g, '/');
  const script = [
    `import('${fileUrl}')`,
    `.then(() => process.exit(0))`,
    `.catch(e => {`,
    `  if (e instanceof SyntaxError) { console.error('SyntaxError:', e.message); process.exit(1); }`,
    `  process.exit(0);`, // non-syntax errors are acceptable (missing deps, env, etc.)
    `});`,
  ].join('');

  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 30_000, encoding: 'utf-8', cwd: root }
  );

  if (result.error) {
    fail(`${label}: Node.js syntax check`, result.error.message);
  } else if (result.status !== 0) {
    fail(`${label}: No SyntaxError`, (result.stderr || result.stdout || '').slice(0, 400));
  } else {
    ok(`${label}: Bundle parses without SyntaxError`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.error('❌ Smoke tests failed — publish aborted.');
  console.error('   See publish/README.md for debugging guidance.\n');
  process.exit(1);
}

console.log('✅ All smoke tests passed.\n');
