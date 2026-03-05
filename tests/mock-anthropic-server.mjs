/**
 * Mock Anthropic API server for integration testing.
 *
 * Spins up a lightweight HTTP server that mimics the Anthropic Messages API
 * (`POST /v1/messages`). Serves **non-streaming JSON responses only**.
 *
 * The agent is configured with `ANTHROPIC_DISABLE_STREAMING=1` so it calls
 * `client.messages.create()` (non-streaming) directly — no streaming
 * attempt, no SSE, no fallback dance. Every request gets the next queued
 * JSON response. This avoids the complexity of emulating the Anthropic SSE
 * streaming protocol (event ordering, delta formats, ping events, etc.)
 * which varies across SDK versions. Non-streaming JSON responses are a
 * stable, well-documented contract.
 *
 * Usage:
 *   import { MockAnthropicServer } from './mock-anthropic-server.mjs';
 *
 *   const server = new MockAnthropicServer();
 *   server.enqueue(                       // first API call returns this
 *     MockAnthropicServer.toolUseResponse('Read', { file_path: 'foo.ts' }),
 *   );
 *   server.enqueue(                       // second API call returns this
 *     MockAnthropicServer.textResponse('Here is the file content.'),
 *   );
 *
 *   await server.start();
 *   // ... run the agent with ANTHROPIC_BASE_URL = server.baseUrl ...
 *   //     and ANTHROPIC_DISABLE_STREAMING = 1
 *   await server.stop();
 *
 *   console.log(server.requests);         // all received request bodies
 */

import { createServer } from 'http';

let _idCounter = 0;
function nextId(prefix = 'mock') {
  return `${prefix}_${String(++_idCounter).padStart(4, '0')}`;
}

/**
 * @typedef {Object} MockResponse
 * @property {string} id
 * @property {'message'} type
 * @property {'assistant'} role
 * @property {string} model
 * @property {'end_turn' | 'tool_use' | 'max_tokens'} stop_reason
 * @property {{input_tokens: number, output_tokens: number}} usage
 * @property {Array<Object>} content
 */

export class MockAnthropicServer {
  constructor() {
    /** @type {MockResponse[]} */
    this._queue = [];
    /** @type {Array<{method: string, url: string, body: Object}>} */
    this.requests = [];
    this._server = null;
    this._port = 0;
  }

  // ── Response builders ──────────────────────────────────────────────────

  /**
   * Build a response with just a text block (stop_reason: end_turn).
   * @param {string} text
   * @returns {MockResponse}
   */
  static textResponse(text) {
    return {
      id: nextId('msg'),
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: Math.ceil(text.length / 4) },
      content: [{ type: 'text', text }],
    };
  }

  /**
   * Build a response with text + one tool_use block (stop_reason: tool_use).
   * @param {string} toolName
   * @param {Object} input
   * @param {string} [text]  Optional preceding text
   * @returns {MockResponse}
   */
  static toolUseResponse(toolName, input, text = '') {
    const content = [];
    if (text) content.push({ type: 'text', text });
    content.push({
      type: 'tool_use',
      id: nextId('toolu'),
      name: toolName,
      input,
    });
    return {
      id: nextId('msg'),
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 20 },
      content,
    };
  }

  /**
   * Build a response with text + multiple tool_use blocks.
   * @param {Array<{name: string, input: Object}>} tools
   * @param {string} [text]
   * @returns {MockResponse}
   */
  static multiToolResponse(tools, text = '') {
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const t of tools) {
      content.push({
        type: 'tool_use',
        id: nextId('toolu'),
        name: t.name,
        input: t.input,
      });
    }
    return {
      id: nextId('msg'),
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 30 },
      content,
    };
  }

  // ── Queue management ───────────────────────────────────────────────────

  /** Add a response to the end of the queue. */
  enqueue(response) {
    this._queue.push(response);
  }

  /** Add multiple responses. */
  enqueueAll(responses) {
    this._queue.push(...responses);
  }

  /** Clear all queued responses and recorded requests. */
  reset() {
    this._queue.length = 0;
    this.requests.length = 0;
  }

  // ── Server lifecycle ───────────────────────────────────────────────────

  /** Start the mock server. Returns when listening. */
  async start() {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => this._handleRequest(req, res));
      this._server.listen(0, '127.0.0.1', () => {
        const addr = this._server.address();
        this._port = addr.port;
        resolve();
      });
      this._server.on('error', reject);
    });
  }

  /** Stop the mock server. */
  async stop() {
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
    });
  }

  /** The base URL to pass as ANTHROPIC_BASE_URL (without /v1). */
  get baseUrl() {
    return `http://127.0.0.1:${this._port}`;
  }

  // ── Request handling ───────────────────────────────────────────────────

  /** @param {import('http').IncomingMessage} req @param {import('http').ServerResponse} res */
  _handleRequest(req, res) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      this.requests.push({ method: req.method, url: req.url, body: parsed });

      // Only handle the messages endpoint
      if (req.url !== '/v1/messages' || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found', message: 'Not found' } }));
        return;
      }

      // Dequeue next response
      const mockResponse = this._queue.shift();
      if (!mockResponse) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { type: 'server_error', message: 'No more mock responses in queue' },
        }));
        return;
      }

      // Return plain JSON (non-streaming)
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockResponse));
    });
  }
}
