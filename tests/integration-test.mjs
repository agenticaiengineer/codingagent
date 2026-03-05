#!/usr/bin/env node
/**
 * Integration test framework — runs the real agent binary against a mock
 * Anthropic API server and verifies end-to-end behavior.
 *
 * Architecture:
 *   ┌────────────┐     HTTP/SSE     ┌─────────────────────┐
 *   │  Agent CLI  │ ──────────────→ │ Mock Anthropic Server│
 *   │ dist/index.js│ ←────────────── │  (scripted responses)│
 *   └────────────┘                  └─────────────────────┘
 *         │
 *         ├── reads/writes files in a temp sandbox
 *         └── stdout/stderr captured for assertions
 *
 * Each test scenario:
 *   1. Creates a temp directory (sandbox)
 *   2. Enqueues scripted LLM responses on the mock server
 *   3. Runs the agent CLI with a prompt via -p flag
 *   4. Asserts on stdout/stderr, file system side-effects, and mock requests
 *
 * Environment isolation:
 *   - HOME/USERPROFILE set to a temp dir (no ~/.claude/settings.json)
 *   - cwd set to an isolated sandbox (no .env files inherited)
 *   - NODE_PATH cleared (no inherited node_modules)
 *   - ANTHROPIC_BASE_URL pointed at mock server
 *   - ANTHROPIC_API_KEY set to a fake key
 *
 * Run:  node scripts/integration-test.mjs            (install + load tests)
 *       node scripts/integration-test.mjs --agent     (agent behavior tests)
 *       node scripts/integration-test.mjs --all       (everything)
 *
 * Add new tests: append to the AGENT_TESTS array below.
 */

import { spawnSync, spawn } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { MockAnthropicServer } from './mock-anthropic-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── CLI flags ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const runInstallSuite = args.includes('--all') || args.includes('--install') || args.length === 0;
const runAgentSuite   = args.includes('--all') || args.includes('--agent');

// ── Helpers ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label) {
  passed++;
  console.log(`  ✓ ${label}`);
}

function fail(label, detail) {
  failed++;
  console.error(`  ✗ ${label}`);
  if (detail) console.error(`    ${detail}`);
}

function skip(label) {
  skipped++;
  console.log(`  ⊘ ${label} (skipped)`);
}

/**
 * Build a clean env object for the agent process.
 * Isolates from user config (settings.json, .env) by pointing HOME to a
 * temp dir. Only passes through essential system env vars.
 *
 * @param {MockAnthropicServer} server
 * @param {string} fakeHome - Path to fake home directory
 * @returns {Object} Environment variables
 */
function buildAgentEnv(server, fakeHome) {
  // Start with minimal system env — we explicitly do NOT spread process.env
  // because that would leak ANTHROPIC_* vars, HOME/.claude/settings.json paths,
  // and other config that defeats isolation.
  const env = {};

  // ── System essentials (needed for Node.js and child processes) ──
  // PATH is required for Bash tool to find commands
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.Path) env.Path = process.env.Path;  // Windows
  // SYSTEMROOT, COMSPEC needed on Windows for cmd.exe/powershell
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.COMSPEC) env.COMSPEC = process.env.COMSPEC;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  // TEMP/TMP needed for Node.js temp file operations
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  // TERM needed for tty detection
  if (process.env.TERM) env.TERM = process.env.TERM;

  // ── Isolation: point HOME to an empty temp dir ──
  // This prevents loadConfig() from reading ~/.claude/settings.json
  // and loadAllEnv() from reading ~/.codingagent/secrets.json.
  env.HOME = fakeHome;
  env.USERPROFILE = fakeHome;  // Windows equivalent

  // ── No inherited NODE_PATH ──
  env.NODE_PATH = '';

  // ── Agent configuration — all pointing at mock server ──
  env.ANTHROPIC_API_KEY = 'sk-ant-fake-integration-test-key-0000000000';
  env.ANTHROPIC_BASE_URL = server.baseUrl;
  env.ANTHROPIC_MODEL = 'mock-model';
  env.ANTHROPIC_SMALL_FAST_MODEL = 'mock-model';
  // Disable streaming so the agent calls client.messages.create() directly.
  // The mock server only serves non-streaming JSON responses — without this,
  // the agent would attempt client.messages.stream() first, which the mock
  // can't handle (no SSE protocol implementation). With streaming disabled,
  // each logical API call produces exactly one HTTP request (no streaming
  // attempt + fallback dance), simplifying test assertions.
  env.ANTHROPIC_DISABLE_STREAMING = '1';

  return env;
}

/**
 * Run the agent CLI with a prompt and mock server.
 *
 * IMPORTANT: Uses async `spawn` (not `spawnSync`). The mock HTTP server
 * runs in the same process, and `spawnSync` blocks the event loop — the
 * server can't accept connections while the child process is running,
 * causing every API call from the agent to hang until the timeout kills
 * the child. With async `spawn`, the event loop remains active and the
 * mock server can serve requests while the agent runs.
 *
 * @param {Object} opts
 * @param {string} opts.prompt          User prompt sent via -p flag
 * @param {string} opts.cwd             Working directory for the agent
 * @param {string} opts.entryPoint      Path to dist/index.js
 * @param {MockAnthropicServer} opts.server  Mock server instance
 * @param {string} opts.fakeHome        Path to fake home directory
 * @param {number} [opts.timeout=30000] Timeout in ms
 * @returns {Promise<{ stdout: string, stderr: string, status: number|null, combined: string }>}
 */
function invokeAgent(opts) {
  const { prompt, cwd, entryPoint, server, fakeHome, timeout = 30_000 } = opts;

  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];

    const child = spawn(
      process.execPath,
      [entryPoint, '-p', prompt],
      {
        cwd,
        env: buildAgentEnv(server, fakeHome),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    // Close stdin immediately — the agent in -p mode doesn't need it,
    // and leaving it open can prevent the agent from detecting non-TTY
    // mode correctly on some platforms.
    child.stdin.end();

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    // Timeout safety net — kill the child if it takes too long
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Give it a moment to exit, then force-kill
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, timeout);

    child.on('close', (status) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      resolve({
        stdout,
        stderr,
        status,
        combined: stdout + stderr,
      });
    });
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Install & Load Tests (no mock server needed)
// ═══════════════════════════════════════════════════════════════════════════

async function runInstallTests() {
  console.log('\n' + '═'.repeat(60));
  console.log(' INSTALL & LOAD TESTS');
  console.log('═'.repeat(60));

  const testDir = join(tmpdir(), `codingagent-integ-install-${Date.now()}`);

  function cleanup() {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    for (const f of readdirSync(root)) {
      if (f.endsWith('.tgz')) {
        try { rmSync(resolve(root, f)); } catch {}
      }
    }
  }

  // ── npm pack ──
  console.log('\n📦 Packing tarball…');
  const pack = spawnSync('npm', ['pack', '--ignore-scripts'], {
    cwd: root, encoding: 'utf-8', shell: true, timeout: 30_000,
  });
  if (pack.status !== 0) {
    fail('npm pack', (pack.stderr || pack.stdout || '').slice(0, 400));
    cleanup();
    return;
  }
  const tgzName = pack.stdout.trim().split('\n').pop();
  const tgzPath = resolve(root, tgzName);
  if (!existsSync(tgzPath)) { fail('Tarball created', `Expected ${tgzPath}`); return; }
  ok(`Tarball created — ${tgzName}`);

  // ── Install ──
  console.log('\n📥 Installing into isolated directory…');
  mkdirSync(testDir, { recursive: true });
  const install = spawnSync('npm', ['install', '--no-save', tgzPath], {
    cwd: testDir, encoding: 'utf-8', shell: true, timeout: 120_000,
  });
  if (install.status !== 0) {
    fail('npm install', (install.stderr || '').slice(0, 400));
    cleanup();
    return;
  }
  ok('Package installed');

  const pkgDir = resolve(testDir, 'node_modules', '@agenticaiengineer', 'codingagent');
  const entryPoint = resolve(pkgDir, 'dist', 'index.js');

  if (!existsSync(entryPoint)) {
    fail('Entry point exists', `${entryPoint} not found`);
    cleanup();
    return;
  }
  ok(`Entry point exists — dist/index.js (${(readFileSync(entryPoint).length / 1024).toFixed(0)} KB)`);

  // ── No problematic static imports ──
  console.log('\n🔍 Checking for problematic static imports…');
  const code = readFileSync(entryPoint, 'utf-8');
  const problematic = ['onnxruntime-node', 'onnxruntime-web', 'sharp', '@huggingface/transformers'];
  let hasProblematic = false;
  for (const pkg of problematic) {
    const re = new RegExp(`import\\s+.*?\\s+from\\s*['"]${pkg.replace(/[/]/g, '\\/')}['"]`);
    if (re.test(code)) {
      fail(`No static import of "${pkg}"`, 'Static ESM import will crash if not installed');
      hasProblematic = true;
    }
  }
  if (!hasProblematic) ok('No static imports of optional native packages');

  // ── Module loads ──
  console.log('\n🚀 Testing module load…');
  const run = spawnSync(process.execPath, [entryPoint], {
    cwd: testDir, encoding: 'utf-8', timeout: 20_000, input: '',
    env: { ...process.env, NODE_PATH: '', ANTHROPIC_API_KEY: '' },
  });
  const combined = (run.stdout || '') + (run.stderr || '');
  if (combined.includes('ERR_MODULE_NOT_FOUND')) {
    const m = combined.match(/Cannot find package '([^']+)'/);
    fail('No ERR_MODULE_NOT_FOUND', `Missing: ${m?.[1] || 'unknown'}`);
  } else { ok('Module loaded — no ERR_MODULE_NOT_FOUND'); }
  if (combined.includes('SyntaxError')) {
    fail('No SyntaxError', combined.match(/SyntaxError: (.+)/)?.[1] || '');
  } else { ok('No SyntaxError'); }

  // ── Gateway loads ──
  console.log('\n🚀 Testing gateway entry point…');
  const gwPath = resolve(pkgDir, 'dist', 'gateway.js');
  if (existsSync(gwPath)) {
    const gwRun = spawnSync(process.execPath, [gwPath], {
      cwd: testDir, encoding: 'utf-8', timeout: 10_000, input: '',
      env: { ...process.env, NODE_PATH: '', ANTHROPIC_API_KEY: '' },
    });
    const gwOut = (gwRun.stdout || '') + (gwRun.stderr || '');
    if (gwOut.includes('ERR_MODULE_NOT_FOUND')) {
      fail('Gateway: no ERR_MODULE_NOT_FOUND', gwOut.match(/Cannot find package '([^']+)'/)?.[1] || '');
    } else { ok('Gateway module loaded'); }
  } else { fail('Gateway entry point exists', 'dist/gateway.js not found'); }

  // ── Agent worker entry point ──
  console.log('\n🚀 Testing agent worker entry point…');
  const awPath = resolve(pkgDir, 'dist', 'agent-worker.js');
  if (existsSync(awPath)) {
    const awRun = spawnSync(process.execPath, [awPath], {
      cwd: testDir, encoding: 'utf-8', timeout: 10_000, input: '',
      env: { ...process.env, NODE_PATH: '', ANTHROPIC_API_KEY: '' },
    });
    const awOut = (awRun.stdout || '') + (awRun.stderr || '');
    if (awOut.includes('ERR_MODULE_NOT_FOUND')) {
      fail('Agent worker: no ERR_MODULE_NOT_FOUND', awOut.match(/Cannot find package '([^']+)'/)?.[1] || '');
    } else { ok('Agent worker module loaded'); }
  } else { fail('Agent worker entry point exists', 'dist/agent-worker.js not found'); }

  cleanup();
}


// ═══════════════════════════════════════════════════════════════════════════
// PART 2: Agent Behavior Tests (with mock server)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} AgentTest
 * @property {string} name                  Test name
 * @property {string} prompt                User prompt
 * @property {Object[]} responses           Mock LLM responses to enqueue
 * @property {Object} [sandbox]             Files to pre-create: { 'path': 'content' }
 * @property {(ctx: {result: Object, sandboxDir: string, server: MockAnthropicServer}) => void} assert
 */

/** @type {AgentTest[]} */
const AGENT_TESTS = [

  // ── Test: Simple text response (no tool use) ────────────────────────────
  {
    name: 'Simple text response — no tool use',
    prompt: 'Say hello',
    responses: [
      MockAnthropicServer.textResponse('Hello! How can I help you today?'),
    ],
    assert({ result }) {
      if (result.combined.includes('Hello! How can I help you today?')) {
        ok('Agent displayed text response');
      } else {
        fail('Agent displayed text response',
          `Output (200 chars): ${result.combined.slice(0, 200)}`);
      }
    },
  },

  // ── Test: Read tool use ─────────────────────────────────────────────────
  {
    name: 'Read tool — reads a file and responds',
    prompt: 'Read the file hello.txt',
    sandbox: { 'hello.txt': 'Hello from the sandbox!' },
    responses: [
      MockAnthropicServer.toolUseResponse(
        'Read',
        { file_path: 'hello.txt' },
        'I\'ll read that file for you.',
      ),
      MockAnthropicServer.textResponse('The file contains: "Hello from the sandbox!"'),
    ],
    assert({ result, server }) {
      // The agent should have made 2 API calls: one for the tool_use response,
      // one for the follow-up after sending the tool_result back.
      // With ANTHROPIC_DISABLE_STREAMING=1, each logical API call is exactly
      // one HTTP request (no streaming attempt + fallback), so server.requests
      // maps 1:1 to logical API calls.
      const reqs = server.requests.filter(r => r.url === '/v1/messages' && r.method === 'POST');
      if (reqs.length >= 2) {
        ok('Agent made follow-up API call after tool result');
      } else {
        fail('Agent made follow-up API call', `Only ${reqs.length} request(s)`);
        return;
      }

      // The second request should contain a tool_result
      const secondReq = reqs[1].body;
      const messages = secondReq.messages || [];
      const lastMsg = messages[messages.length - 1];
      const hasToolResult = lastMsg?.content?.some?.(b => b.type === 'tool_result');
      if (hasToolResult) {
        ok('Tool result sent back to API');
      } else {
        fail('Tool result sent back to API',
          `Last message type: ${JSON.stringify(lastMsg?.content?.[0]?.type)}`);
        return;
      }

      // The tool result content should contain the file content
      const toolResult = lastMsg?.content?.find?.(b => b.type === 'tool_result');
      const resultContent = typeof toolResult?.content === 'string'
        ? toolResult.content
        : toolResult?.content?.[0]?.text || '';
      if (resultContent.includes('Hello from the sandbox')) {
        ok('Tool result contains file content');
      } else {
        fail('Tool result contains file content', `Got: ${resultContent.slice(0, 100)}`);
      }
    },
  },

  // ── Test: Write tool — creates a file ───────────────────────────────────
  {
    name: 'Write tool — creates a new file',
    prompt: 'Create a file called output.txt with the text "test passed"',
    responses: [
      MockAnthropicServer.toolUseResponse(
        'Write',
        { file_path: 'output.txt', content: 'test passed' },
        'I\'ll create that file.',
      ),
      MockAnthropicServer.textResponse('Done! I\'ve created output.txt.'),
    ],
    assert({ result, sandboxDir }) {
      const outputPath = join(sandboxDir, 'output.txt');
      if (existsSync(outputPath)) {
        ok('Write tool created the file');
        const content = readFileSync(outputPath, 'utf-8');
        if (content.includes('test passed')) {
          ok('File has correct content');
        } else {
          fail('File has correct content', `Got: ${content.slice(0, 100)}`);
        }
      } else {
        fail('Write tool created the file', 'output.txt not found');
      }
    },
  },

  // ── Test: Bash tool — runs a command ────────────────────────────────────
  {
    name: 'Bash tool — runs a command and returns output',
    prompt: 'Run echo hello',
    responses: [
      MockAnthropicServer.toolUseResponse(
        'Bash',
        { command: 'echo integration-test-sentinel' },
        'I\'ll run that command.',
      ),
      MockAnthropicServer.textResponse('The command output "integration-test-sentinel".'),
    ],
    assert({ result, server }) {
      const reqs = server.requests.filter(r => r.url === '/v1/messages' && r.method === 'POST');
      if (reqs.length < 2) {
        fail('Agent made follow-up call after Bash', `Only ${reqs.length} request(s)`);
        return;
      }

      const secondReq = reqs[1].body;
      const messages = secondReq.messages || [];
      const lastMsg = messages[messages.length - 1];
      const toolResult = lastMsg?.content?.find?.(b => b.type === 'tool_result');
      const resultContent = typeof toolResult?.content === 'string'
        ? toolResult.content
        : toolResult?.content?.[0]?.text || '';
      if (resultContent.includes('integration-test-sentinel')) {
        ok('Bash tool result contains command output');
      } else {
        fail('Bash tool result contains command output', `Got: ${resultContent.slice(0, 200)}`);
      }
    },
  },

  // ── Test: Multi-tool — reads then writes ────────────────────────────────
  {
    name: 'Multi-tool — read + write in one turn',
    prompt: 'Read input.txt and write its content to copy.txt',
    sandbox: { 'input.txt': 'copy me please' },
    responses: [
      MockAnthropicServer.multiToolResponse(
        [
          { name: 'Read', input: { file_path: 'input.txt' } },
          { name: 'Write', input: { file_path: 'copy.txt', content: 'copy me please' } },
        ],
        'I\'ll read the source and create the copy.',
      ),
      MockAnthropicServer.textResponse('Done! Copied input.txt to copy.txt.'),
    ],
    assert({ result, sandboxDir, server }) {
      const reqs = server.requests.filter(r => r.url === '/v1/messages' && r.method === 'POST');
      if (reqs.length >= 2) {
        const secondReq = reqs[1].body;
        const messages = secondReq.messages || [];
        const lastMsg = messages[messages.length - 1];
        const toolResults = (lastMsg?.content || []).filter(b => b.type === 'tool_result');
        if (toolResults.length >= 2) {
          ok('Both tool results sent back');
        } else {
          fail('Both tool results sent back', `Only ${toolResults.length} result(s)`);
        }
      } else {
        fail('Follow-up API call made', `Only ${reqs.length} request(s)`);
      }

      const copyPath = join(sandboxDir, 'copy.txt');
      if (existsSync(copyPath)) {
        const content = readFileSync(copyPath, 'utf-8');
        if (content.includes('copy me please')) {
          ok('Copy file has correct content');
        } else {
          fail('Copy file has correct content', `Got: ${content}`);
        }
      } else {
        fail('Copy file created', 'copy.txt not found');
      }
    },
  },

  // ── Test: Edit tool ─────────────────────────────────────────────────────
  {
    name: 'Edit tool — replaces text in a file',
    prompt: 'Replace "world" with "universe" in greet.txt',
    sandbox: { 'greet.txt': 'Hello, world!' },
    responses: [
      // The Edit tool requires reading the file first (readFileState check)
      MockAnthropicServer.toolUseResponse(
        'Read',
        { file_path: 'greet.txt' },
        'I\'ll read the file first.',
      ),
      // After reading, the agent sends tool_result back and gets Edit instruction
      MockAnthropicServer.toolUseResponse(
        'Edit',
        { file_path: 'greet.txt', old_string: 'world', new_string: 'universe' },
        'Now I\'ll make that replacement.',
      ),
      MockAnthropicServer.textResponse('Done! Changed "world" to "universe".'),
    ],
    assert({ sandboxDir }) {
      const content = readFileSync(join(sandboxDir, 'greet.txt'), 'utf-8');
      if (content.includes('universe') && !content.includes('world')) {
        ok('Edit replaced text correctly');
      } else {
        fail('Edit replaced text correctly', `File now contains: ${content}`);
      }
    },
  },

  // ── Test: Glob tool ─────────────────────────────────────────────────────
  {
    name: 'Glob tool — finds matching files',
    prompt: 'Find all .txt files',
    sandbox: { 'a.txt': 'A', 'b.txt': 'B', 'c.js': 'C' },
    responses: [
      MockAnthropicServer.toolUseResponse(
        'Glob',
        { pattern: '*.txt' },
        'I\'ll search for .txt files.',
      ),
      MockAnthropicServer.textResponse('Found 2 .txt files: a.txt and b.txt.'),
    ],
    assert({ server }) {
      const reqs = server.requests.filter(r => r.url === '/v1/messages' && r.method === 'POST');
      if (reqs.length < 2) {
        fail('Glob follow-up call', `Only ${reqs.length} request(s)`);
        return;
      }
      const secondReq = reqs[1].body;
      const messages = secondReq.messages || [];
      const lastMsg = messages[messages.length - 1];
      const toolResult = lastMsg?.content?.find?.(b => b.type === 'tool_result');
      const content = typeof toolResult?.content === 'string'
        ? toolResult.content
        : toolResult?.content?.[0]?.text || '';
      if (content.includes('a.txt') && content.includes('b.txt')) {
        ok('Glob result contains matching files');
      } else {
        fail('Glob result contains matching files', `Got: ${content.slice(0, 200)}`);
      }
    },
  },

];


async function runAgentTests() {
  console.log('\n' + '═'.repeat(60));
  console.log(' AGENT BEHAVIOR TESTS');
  console.log('═'.repeat(60));

  // Resolve the entry point — use local dist/ (no need to pack for agent tests)
  const entryPoint = resolve(root, 'dist', 'index.js');
  if (!existsSync(entryPoint)) {
    fail('dist/index.js exists', 'Run `npm run bundle` first');
    return;
  }

  const server = new MockAnthropicServer();
  await server.start();
  console.log(`\n🌐 Mock server listening on ${server.baseUrl}`);

  // Create a fake HOME with no settings.json — this isolates the agent
  // from the developer's config (model overrides, API keys, etc.)
  const fakeHome = join(tmpdir(), `codingagent-integ-home-${Date.now()}`);
  mkdirSync(fakeHome, { recursive: true });

  for (const test of AGENT_TESTS) {
    console.log(`\n── ${test.name} ──`);

    // Create sandbox
    const sandboxDir = join(tmpdir(), `codingagent-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(sandboxDir, { recursive: true });

    // Pre-create sandbox files
    if (test.sandbox) {
      for (const [filePath, content] of Object.entries(test.sandbox)) {
        const abs = join(sandboxDir, filePath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }

    // Enqueue mock responses
    server.reset();
    server.enqueueAll(test.responses);

    // Run the agent
    const result = await invokeAgent({
      prompt: test.prompt,
      cwd: sandboxDir,
      entryPoint,
      server,
      fakeHome,
      timeout: 30_000,
    });

    // Run assertions
    try {
      test.assert({ result, sandboxDir, server });
    } catch (err) {
      fail(`${test.name} — assertion threw`, err.message);
    }

    // Cleanup sandbox
    try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
  }

  // Cleanup
  await server.stop();
  try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
}


// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  if (runInstallSuite) {
    await runInstallTests();
  }

  if (runAgentSuite) {
    await runAgentTests();
  }

  if (!runInstallSuite && !runAgentSuite) {
    await runInstallTests();
  }

  // ── Summary ──
  const total = passed + failed + skipped;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` ${total} checks: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  console.log('═'.repeat(60) + '\n');

  if (failed > 0) {
    console.error('❌ Integration tests failed.\n');
    process.exit(1);
  }

  console.log('✅ All integration tests passed.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
