import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

/**
 * esbuild plugin: rewrite optional native modules so they use dynamic import()
 * wrapped in try/catch instead of static top-level `import` statements.
 *
 * Why: esbuild hoists externals as static ESM imports. For optional native deps
 * like onnxruntime-node and sharp (pulled in by @huggingface/transformers' internal
 * webpack runtime), this causes ERR_MODULE_NOT_FOUND at startup when they aren't
 * installed. Dynamic import() with a catch lets the app start and only fail when
 * the feature (e.g., transcription) is actually used.
 */
function optionalExternalsPlugin(packages) {
  return {
    name: 'optional-externals',
    setup(build) {
      // For each optional package, intercept the import and return a lazy proxy
      for (const pkg of packages) {
        const filter = new RegExp(`^${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        build.onResolve({ filter }, (args) => ({
          path: args.path,
          namespace: 'optional-external',
        }));
      }

      build.onLoad({ filter: /.*/, namespace: 'optional-external' }, (args) => ({
        // Export a Proxy that lazily attempts a dynamic import on first property access.
        // If the package is missing at runtime, the proxy methods throw a clear error.
        contents: `
          let _mod;
          let _err;
          const _load = async () => {
            if (_mod) return _mod;
            try { _mod = await import(${JSON.stringify(args.path)}); return _mod; }
            catch (e) { _err = e; return null; }
          };
          // Eagerly attempt (but don't block) so the module is ready when needed
          _load();
          export default new Proxy({}, {
            get(_, prop) {
              if (_mod) return _mod[prop];
              if (_err) throw new Error("Optional dependency '${args.path}' is not installed: " + _err.message);
              // Not loaded yet — return a function that awaits loading
              return (...a) => _load().then(m => { if (m && typeof m[prop] === 'function') return m[prop](...a); throw new Error("Optional dependency '${args.path}' is not available"); });
            }
          });
          // Re-export a wildcard so named imports also resolve
          export const __esModule = true;
        `,
        loader: 'js',
      }));
    },
  };
}

const entries = [
  { in: 'src/index.ts', out: 'dist/index.js', shebang: '' },
  { in: 'src/gateway/gateway.ts', out: 'dist/gateway.js', shebang: '' },
  { in: 'src/gateway/agent-worker.ts', out: 'dist/agent-worker.js', shebang: '' },
];

async function bundleAll() {
  mkdirSync('dist', { recursive: true });

  for (const entry of entries) {
    const bundleOut = entry.out.replace(/\.js$/, '.bundle.js');
    console.log(`Bundling ${entry.in} -> ${bundleOut} ...`);

    // Bundle with esbuild into a single file.
    // Create a require() shim for ESM — some CJS deps (e.g., node-fetch) use
    // dynamic require() for Node.js built-ins, which ESM doesn't support natively.
    const requireShim = `
import { createRequire as __bundleCreateRequire } from 'module';
const require = __bundleCreateRequire(import.meta.url);
`;
    await build({
      entryPoints: [entry.in],
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      outfile: bundleOut,
      banner: { js: (entry.shebang || '') + requireShim },
      logOverride: { 'direct-eval': 'silent' },
      plugins: [
        // Rewrite optional native deps as lazy dynamic imports so the app
        // doesn't crash with ERR_MODULE_NOT_FOUND when they're absent.
        optionalExternalsPlugin([
          'onnxruntime-node',
          'onnxruntime-web',
          'sharp',
        ]),
      ],
      // Mark native/binary modules and heavy optional deps as external.
      // NOTE: onnxruntime-node, onnxruntime-web, and sharp are handled by
      // optionalExternalsPlugin above — they must NOT be listed here or
      // esbuild will emit static ESM imports that crash on startup.
      external: [
        'fsevents',
        'cpu-features',
        'ssh2',
        'bufferutil',
        'utf-8-validate',
        '@playwright/test',
        'playwright-core',
        'playwright',
        'chromium-bidi',
      ],
      minify: true,
      sourcemap: true,
      treeShaking: true,
    });

    // Copy the bundle to the final output path, preserving the shebang.
    let code = readFileSync(bundleOut, 'utf-8');

    // Preserve shebang
    let shebang = '';
    if (code.startsWith('#!')) {
      const idx = code.indexOf('\n');
      shebang = code.slice(0, idx + 1);
      code = code.slice(idx + 1);
    }

    writeFileSync(entry.out, shebang + code);
    console.log(`Done: ${entry.out}`);
  }

  console.log('\nAll entries bundled!');
}

bundleAll().catch((err) => {
  console.error('Bundle failed:', err);
  process.exit(1);
});
