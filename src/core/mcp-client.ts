/**
 * MCP (Model Context Protocol) Client
 *
 * Connects to MCP servers via stdio or HTTP transport, discovers tools,
 * and bridges them into the codingagent tool system. Implements the
 * JSON-RPC 2.0 protocol directly without external MCP SDK dependencies.
 *
 * Configuration sources:
 *   1. `.mcp.json` at project root (team-shared, project scope)
 *   2. `~/.claude.json` under `mcpServers` (user scope, all projects)
 *
 * Features:
 *   - stdio transport (spawn child process, communicate via stdin/stdout)
 *   - HTTP transport (POST requests to remote MCP servers)
 *   - JSON-RPC 2.0 request/response/notification protocol
 *   - Tool discovery via `tools/list` → bridged to codingagent Tool interface
 *   - Tool invocation via `tools/call`
 *   - Resource discovery/read (`resources/list`, `resources/read`)
 *   - Environment variable expansion in config (`${VAR}`, `${VAR:-default}`)
 *   - Auto-reconnect on stdio server crash
 *   - Graceful shutdown on process exit
 */

import { spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { printWarning } from "../ui/ui.js";
import { hasErrnoCode, safeTruncate } from "../tools/validate.js";
import type { Tool, ToolInput, ToolContext, ToolResult } from "./types.js";

// ── JSON-RPC 2.0 Types ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── MCP Protocol Types ──

interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}

interface McpResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

interface McpServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean; listChanged?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpServerCapabilities;
  serverInfo: { name: string; version: string };
  instructions?: string;
}

// ── MCP Server Configuration ──

interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpHttpServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

interface McpServersConfig {
  mcpServers?: Record<string, McpServerConfig>;
}

// ── Connection State ──

export interface McpServerStatus {
  name: string;
  type: "stdio" | "http" | "sse";
  state: "connecting" | "connected" | "disconnected" | "error";
  toolCount: number;
  resourceCount: number;
  error?: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

interface McpStdioConnection {
  type: "stdio";
  process: ChildProcess;
  buffer: string;
  nextId: number;
  pendingRequests: Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  config: McpStdioServerConfig;
}

interface McpHttpConnection {
  type: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  nextId: number;
}

type McpConnection = McpStdioConnection | McpHttpConnection;

interface McpServer {
  name: string;
  config: McpServerConfig;
  connection: McpConnection | null;
  status: McpServerStatus;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  capabilities: McpServerCapabilities;
  instructions?: string;
}

// ── Module State ──

const servers = new Map<string, McpServer>();
let initialized = false;

// ── Environment Variable Expansion ──

function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const parts = expr.split(":-");
    const varName = parts[0].trim();
    const defaultValue = parts.length > 1 ? parts.slice(1).join(":-") : "";
    return process.env[varName] ?? defaultValue;
  });
}

function expandConfigEnvVars(config: McpServerConfig): McpServerConfig {
  if ("command" in config) {
    const expanded: McpStdioServerConfig = {
      ...config,
      command: expandEnvVars(config.command),
      args: config.args?.map(expandEnvVars),
      cwd: config.cwd ? expandEnvVars(config.cwd) : undefined,
    };
    if (config.env) {
      expanded.env = {};
      for (const [key, val] of Object.entries(config.env)) {
        expanded.env[key] = expandEnvVars(val);
      }
    }
    return expanded;
  } else {
    const expanded: McpHttpServerConfig = {
      ...config,
      url: expandEnvVars(config.url),
    };
    if (config.headers) {
      expanded.headers = {};
      for (const [key, val] of Object.entries(config.headers)) {
        expanded.headers[key] = expandEnvVars(val);
      }
    }
    return expanded;
  }
}

// ── Configuration Loading ──

function loadMcpConfigs(cwd: string): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};

  // User scope: ~/.claude.json
  try {
    const userPath = join(homedir(), ".claude.json");
    const raw: unknown = JSON.parse(readFileSync(userPath, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as McpServersConfig;
      if (obj.mcpServers && typeof obj.mcpServers === "object") {
        for (const [name, serverConfig] of Object.entries(obj.mcpServers)) {
          if (serverConfig && typeof serverConfig === "object") {
            configs[name] = expandConfigEnvVars(serverConfig as McpServerConfig);
          }
        }
      }
    }
  } catch (err: unknown) {
    if (!hasErrnoCode(err) || (err as { code: string }).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      printWarning(`Failed to read ~/.claude.json: ${msg}`);
    }
  }

  // Project scope: .mcp.json (takes precedence)
  try {
    const projectPath = join(cwd, ".mcp.json");
    const raw: unknown = JSON.parse(readFileSync(projectPath, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as McpServersConfig;
      if (obj.mcpServers && typeof obj.mcpServers === "object") {
        for (const [name, serverConfig] of Object.entries(obj.mcpServers)) {
          if (serverConfig && typeof serverConfig === "object") {
            configs[name] = expandConfigEnvVars(serverConfig as McpServerConfig);
          }
        }
      }
    }
  } catch (err: unknown) {
    if (!hasErrnoCode(err) || (err as { code: string }).code !== "ENOENT") {
      const msg = err instanceof Error ? err.message : String(err);
      printWarning(`Failed to read .mcp.json: ${msg}`);
    }
  }

  return configs;
}

// ── stdio Transport ──

function sendStdioRequest(
  conn: McpStdioConnection,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  const id = conn.nextId++;
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params != null ? { params } : {}),
  };

  return new Promise((resolveReq, rejectReq) => {
    const timeout = setTimeout(() => {
      conn.pendingRequests.delete(id);
      rejectReq(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();

    conn.pendingRequests.set(id, { resolve: resolveReq, reject: rejectReq, timeout });

    const line = JSON.stringify(request) + "\n";
    try {
      if (conn.process.stdin && !conn.process.stdin.destroyed) {
        conn.process.stdin.write(line);
      } else {
        conn.pendingRequests.delete(id);
        clearTimeout(timeout);
        rejectReq(new Error("MCP server stdin is not writable"));
      }
    } catch (err: unknown) {
      conn.pendingRequests.delete(id);
      clearTimeout(timeout);
      rejectReq(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function sendStdioNotification(
  conn: McpStdioConnection,
  method: string,
  params?: Record<string, unknown>
): void {
  const notification: JsonRpcNotification = {
    jsonrpc: "2.0",
    method,
    ...(params != null ? { params } : {}),
  };
  const line = JSON.stringify(notification) + "\n";
  try {
    if (conn.process.stdin && !conn.process.stdin.destroyed) {
      conn.process.stdin.write(line);
    }
  } catch { /* best-effort */ }
}

function handleStdioData(server: McpServer, data: string): void {
  const conn = server.connection;
  if (!conn || conn.type !== "stdio") return;

  conn.buffer += data;

  let newlineIdx: number;
  while ((newlineIdx = conn.buffer.indexOf("\n")) !== -1) {
    const line = conn.buffer.slice(0, newlineIdx).trim();
    conn.buffer = conn.buffer.slice(newlineIdx + 1);
    if (!line) continue;

    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      continue; // Not valid JSON — skip debug output
    }

    // Handle notifications
    if (msg.id === null || msg.id === undefined) {
      handleServerNotification(server, msg as unknown as JsonRpcNotification);
      continue;
    }

    // Handle responses
    const pending = conn.pendingRequests.get(msg.id);
    if (pending) {
      conn.pendingRequests.delete(msg.id);
      clearTimeout(pending.timeout);
      if (msg.error) {
        pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }
}

function handleServerNotification(server: McpServer, notification: JsonRpcNotification): void {
  switch (notification.method) {
    case "notifications/tools/list_changed":
      refreshServerTools(server).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        printWarning(`Failed to refresh tools from MCP server "${server.name}": ${msg}`);
      });
      break;
    case "notifications/resources/list_changed":
      refreshServerResources(server).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        printWarning(`Failed to refresh resources from MCP server "${server.name}": ${msg}`);
      });
      break;
    default:
      break;
  }
}

async function connectStdio(server: McpServer, config: McpStdioServerConfig): Promise<void> {
  server.status.state = "connecting";
  server.status.type = "stdio";

  const childEnv = { ...process.env, ...(config.env ?? {}) };
  delete childEnv.CODINGAGENT_RELOAD;

  const resolvedCwd = config.cwd ? resolve(config.cwd) : process.cwd();

  let child: ChildProcess;
  try {
    if (process.platform === "win32") {
      // On Windows we need shell:true so that commands like "node" or "npx"
      // resolve correctly. But passing args with shell:true triggers
      // [DEP0190] in Node 22+. Build a single command string instead.
      const escaped = (config.args ?? []).map((a) =>
        /["\s]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
      );
      const fullCmd = [config.command, ...escaped].join(" ");
      child = spawn(fullCmd, [], {
        cwd: resolvedCwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });
    } else {
      child = spawn(config.command, config.args ?? [], {
        cwd: resolvedCwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    server.status.state = "error";
    server.status.error = `Failed to spawn: ${msg}`;
    throw new Error(`Failed to spawn MCP server "${server.name}": ${msg}`);
  }

  const conn: McpStdioConnection = {
    type: "stdio",
    process: child,
    buffer: "",
    nextId: 1,
    pendingRequests: new Map(),
    config,
  };
  server.connection = conn;

  child.stdout?.setEncoding("utf-8");
  child.stdout?.on("data", (data: string) => handleStdioData(server, data));

  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (data: string) => {
    const trimmed = data.trim();
    if (!trimmed) return;

    // MCP servers use stdout for JSON-RPC, so they commonly log
    // informational messages to stderr. Only surface lines that look
    // like actual errors or warnings — skip INFO/DEBUG/TRACE noise
    // and Node.js runtime warnings (ExperimentalWarning, DeprecationWarning).
    const lower = trimmed.toLowerCase();
    if (
      lower.includes("[info]") ||
      lower.includes("[debug]") ||
      lower.includes("[trace]") ||
      lower.includes("level\":\"info") ||
      lower.includes("level\":\"debug") ||
      lower.includes("level\":\"trace") ||
      lower.includes("\"level\":20") ||  // pino debug
      lower.includes("\"level\":30") ||  // pino info
      lower.includes("experimentalwarning:") ||
      lower.includes("deprecationwarning:") ||
      /\(node:\d+\)/.test(trimmed)       // Node.js process warnings: (node:12345) ...
    ) {
      return;
    }

    const firstLine = trimmed.split("\n")[0];
    const truncated = firstLine.length > 200 ? safeTruncate(firstLine, 200) + "…" : firstLine;
    printWarning(`MCP "${server.name}" stderr: ${truncated}`);
  });

  child.on("exit", (code, signal) => {
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`MCP server "${server.name}" exited (code=${code}, signal=${signal})`));
    }
    conn.pendingRequests.clear();

    if (server.status.state === "connected") {
      server.status.state = "disconnected";
      server.status.error = `Process exited (code=${code}, signal=${signal})`;
      printWarning(`MCP server "${server.name}" exited unexpectedly (code=${code}). Its tools are no longer available.`);
    }
  });

  child.on("error", (err) => {
    server.status.state = "error";
    server.status.error = err.message;
    for (const [, pending] of conn.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    conn.pendingRequests.clear();
  });

  // Wait briefly for process to start
  await new Promise<void>((resolveWait, rejectWait) => {
    const timeout = setTimeout(() => resolveWait(), 500);
    timeout.unref();
    child.on("error", (err) => { clearTimeout(timeout); rejectWait(err); });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        rejectWait(new Error(`MCP server "${server.name}" exited immediately with code ${code}`));
      }
    });
  });

  // MCP initialization handshake
  const initResult = await sendStdioRequest(conn, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "codingagent", version: "0.1.0" },
  }) as McpInitializeResult;

  server.capabilities = initResult.capabilities ?? {};
  server.status.serverInfo = initResult.serverInfo;
  server.instructions = initResult.instructions;

  sendStdioNotification(conn, "notifications/initialized");

  server.status.state = "connected";
  server.status.error = undefined;
}

// ── HTTP Transport ──

async function sendHttpRequest(
  conn: McpHttpConnection,
  method: string,
  params?: Record<string, unknown>,
  _timeoutMs = 30_000
): Promise<unknown> {
  const id = conn.nextId++;
  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params != null ? { params } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), _timeoutMs);

  try {
    const response = await fetch(conn.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...conn.headers },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body ? safeTruncate(body, 200) : response.statusText}`);
    }

    const msg = (await response.json()) as JsonRpcResponse;
    if (msg.error) {
      throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    }
    return msg.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectHttp(server: McpServer, config: McpHttpServerConfig): Promise<void> {
  server.status.state = "connecting";
  server.status.type = config.type;

  const conn: McpHttpConnection = {
    type: config.type,
    url: config.url,
    headers: config.headers ?? {},
    nextId: 1,
  };
  server.connection = conn;

  const initResult = await sendHttpRequest(conn, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "codingagent", version: "0.1.0" },
  }) as McpInitializeResult;

  server.capabilities = initResult.capabilities ?? {};
  server.status.serverInfo = initResult.serverInfo;
  server.instructions = initResult.instructions;

  // Fire-and-forget initialized notification
  try {
    await fetch(conn.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...conn.headers },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" } satisfies JsonRpcNotification),
    });
  } catch { /* best-effort */ }

  server.status.state = "connected";
  server.status.error = undefined;
}

// ── Tool/Resource Discovery ──

async function refreshServerTools(server: McpServer): Promise<void> {
  if (!server.connection || server.status.state !== "connected") return;
  try {
    const result = server.connection.type === "stdio"
      ? await sendStdioRequest(server.connection, "tools/list")
      : await sendHttpRequest(server.connection, "tools/list");
    const toolsResult = result as { tools?: McpToolDefinition[] };
    server.tools = toolsResult.tools ?? [];
    server.status.toolCount = server.tools.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`Failed to list tools from MCP server "${server.name}": ${msg}`);
  }
}

async function refreshServerResources(server: McpServer): Promise<void> {
  if (!server.connection || server.status.state !== "connected") return;
  if (!server.capabilities.resources) return;
  try {
    const result = server.connection.type === "stdio"
      ? await sendStdioRequest(server.connection, "resources/list")
      : await sendHttpRequest(server.connection, "resources/list");
    const resourcesResult = result as { resources?: McpResourceDefinition[] };
    server.resources = resourcesResult.resources ?? [];
    server.status.resourceCount = server.resources.length;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`Failed to list resources from MCP server "${server.name}": ${msg}`);
  }
}

// ── Tool Invocation ──

/**
 * Maximum retries for transient MCP tool call failures.
 * MCP servers can experience transient issues (network blips for HTTP,
 * process restarts for stdio). A single retry often resolves the issue
 * without wasting an API round-trip for the model to re-issue the tool call.
 */
const MCP_TOOL_CALL_MAX_RETRIES = 2;
const MCP_TOOL_CALL_BASE_DELAY_MS = 500;

/** Simple exponential backoff with jitter for MCP retries. */
function mcpBackoffDelay(attempt: number): number {
  const base = Math.min(MCP_TOOL_CALL_BASE_DELAY_MS * Math.pow(2, attempt), 10_000);
  const jitter = base * 0.25 * (2 * Math.random() - 1);
  return Math.max(0, base + jitter);
}

/** Sleep that respects an optional abort signal. */
function mcpSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

/**
 * Determine if an MCP error is transient and worth retrying.
 * Returns false for errors that indicate a permanent problem (bad arguments,
 * tool not found, etc.) where a retry would fail identically.
 */
function isMcpTransientError(msg: string): boolean {
  const lower = msg.toLowerCase();
  // Permanent errors — don't retry
  if (
    lower.includes("tool not found") ||
    lower.includes("unknown tool") ||
    lower.includes("invalid argument") ||
    lower.includes("invalid param") ||
    lower.includes("validation error") ||
    lower.includes("not connected")
  ) {
    return false;
  }
  // Timeouts, network errors, and server errors are transient
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("epipe") ||
    lower.includes("exited") ||
    lower.includes("http 5") ||
    lower.includes("http 429") ||
    lower.includes("socket") ||
    lower.includes("network")
  ) {
    return true;
  }
  // Default: treat as transient (better to retry once than fail)
  return true;
}

/**
 * Attempt to reconnect a disconnected/errored MCP server.
 * Returns true if reconnection succeeded.
 */
async function tryReconnect(server: McpServer): Promise<boolean> {
  if (server.status.state === "connected") return true;
  if (server.status.state !== "disconnected" && server.status.state !== "error") return false;

  printWarning(`MCP server "${server.name}" is ${server.status.state}, attempting reconnection…`);

  try {
    const config = server.config;
    if ("command" in config) {
      await connectStdio(server, config);
    } else {
      await connectHttp(server, config as McpHttpServerConfig);
    }
    await Promise.all([refreshServerTools(server), refreshServerResources(server)]);
    printWarning(`MCP server "${server.name}" reconnected successfully.`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    server.status.state = "error";
    server.status.error = `Reconnection failed: ${msg}`;
    return false;
  }
}

async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // If server is disconnected/errored, attempt reconnection before failing
  if (server.status.state !== "connected") {
    const reconnected = await tryReconnect(server);
    if (!reconnected) {
      return { content: `Error: MCP server "${server.name}" is not connected and reconnection failed.`, is_error: true };
    }
  }

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MCP_TOOL_CALL_MAX_RETRIES; attempt++) {
    try {
      const result = server.connection!.type === "stdio"
        ? await sendStdioRequest(server.connection as McpStdioConnection, "tools/call", { name: toolName, arguments: args }, 60_000)
        : await sendHttpRequest(server.connection as McpHttpConnection, "tools/call", { name: toolName, arguments: args }, 60_000);

      const toolResult = result as {
        content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
        isError?: boolean;
      };

      const contentParts: string[] = [];
      for (const block of toolResult.content ?? []) {
        if (block.type === "text" && block.text) contentParts.push(block.text);
        else if (block.type === "image" && block.data) contentParts.push(`[Image: ${block.mimeType ?? "image/unknown"}, ${block.data.length} bytes]`);
        else if (block.type === "resource" && block.text) contentParts.push(block.text);
      }

      return { content: contentParts.join("\n") || "(No output)", is_error: toolResult.isError ?? false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;

      // Don't retry non-transient errors
      if (!isMcpTransientError(msg)) {
        return { content: `Error calling MCP tool "${toolName}" on "${server.name}": ${msg}`, is_error: true };
      }

      // Out of retries
      if (attempt >= MCP_TOOL_CALL_MAX_RETRIES) break;

      // If the server disconnected mid-call, try to reconnect
      if (server.status.state !== "connected") {
        const reconnected = await tryReconnect(server);
        if (!reconnected) break;
      }

      const delay = mcpBackoffDelay(attempt);
      printWarning(
        `MCP tool "${toolName}" failed (${safeTruncate(msg, 80)}). Retrying in ${(delay / 1000).toFixed(1)}s (retry ${attempt + 1}/${MCP_TOOL_CALL_MAX_RETRIES})…`
      );
      await mcpSleep(delay);
    }
  }

  return { content: `Error calling MCP tool "${toolName}" on "${server.name}": ${lastError ?? "unknown error"} (after ${MCP_TOOL_CALL_MAX_RETRIES + 1} attempts)`, is_error: true };
}

export async function readMcpResource(serverName: string, uri: string): Promise<ToolResult> {
  const server = servers.get(serverName);
  if (!server) return { content: `Error: MCP server "${serverName}" not found.`, is_error: true };

  // Attempt reconnection if disconnected
  if (server.status.state !== "connected") {
    const reconnected = await tryReconnect(server);
    if (!reconnected) {
      return { content: `Error: MCP server "${serverName}" is not connected and reconnection failed.`, is_error: true };
    }
  }

  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MCP_TOOL_CALL_MAX_RETRIES; attempt++) {
    try {
      const result = server.connection!.type === "stdio"
        ? await sendStdioRequest(server.connection as McpStdioConnection, "resources/read", { uri })
        : await sendHttpRequest(server.connection as McpHttpConnection, "resources/read", { uri });
      const rr = result as { contents?: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
      const parts: string[] = [];
      for (const c of rr.contents ?? []) {
        if (c.text) parts.push(c.text);
        else if (c.blob) parts.push(`[Binary: ${c.mimeType ?? "application/octet-stream"}, ${c.blob.length} bytes]`);
      }
      return { content: parts.join("\n") || "(Empty resource)" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;

      if (!isMcpTransientError(msg)) {
        return { content: `Error reading resource "${uri}" from "${serverName}": ${msg}`, is_error: true };
      }

      if (attempt >= MCP_TOOL_CALL_MAX_RETRIES) break;

      if (server.status.state !== "connected") {
        const reconnected = await tryReconnect(server);
        if (!reconnected) break;
      }

      const delay = mcpBackoffDelay(attempt);
      printWarning(
        `MCP resource read "${uri}" failed (${safeTruncate(msg, 80)}). Retrying in ${(delay / 1000).toFixed(1)}s (retry ${attempt + 1}/${MCP_TOOL_CALL_MAX_RETRIES})…`
      );
      await mcpSleep(delay);
    }
  }

  return { content: `Error reading resource "${uri}" from "${serverName}": ${lastError ?? "unknown error"} (after ${MCP_TOOL_CALL_MAX_RETRIES + 1} attempts)`, is_error: true };
}

// ── Tool Bridging ──

function bridgeMcpTool(server: McpServer, mcpTool: McpToolDefinition): Tool {
  const qualifiedName = `mcp__${server.name}__${mcpTool.name}`;
  const isSafe = mcpTool.annotations?.readOnlyHint === true && mcpTool.annotations?.destructiveHint !== true;

  return {
    name: qualifiedName,
    description: `${mcpTool.description ?? `MCP tool: ${mcpTool.name}`}\n(from MCP server: ${server.name})`,
    inputSchema: mcpTool.inputSchema ?? { type: "object" as const, properties: {} },
    isConcurrencySafe: isSafe ?? false,
    async execute(input: ToolInput, _context: ToolContext): Promise<ToolResult> {
      return callMcpTool(server, mcpTool.name, input);
    },
  };
}

// ── Public API ──

export async function loadMcpServers(cwd: string): Promise<void> {
  if (initialized) await shutdownMcpServers();
  initialized = true;

  const configs = loadMcpConfigs(cwd);
  if (Object.keys(configs).length === 0) return;

  const connectPromises: Promise<void>[] = [];

  for (const [name, config] of Object.entries(configs)) {
    const server: McpServer = {
      name, config, connection: null,
      status: {
        name,
        type: "command" in config ? "stdio" : ((config as McpHttpServerConfig).type ?? "http"),
        state: "connecting", toolCount: 0, resourceCount: 0,
      },
      tools: [], resources: [], capabilities: {},
    };
    servers.set(name, server);

    const connectAndDiscover = async () => {
      try {
        if ("command" in config) await connectStdio(server, config);
        else await connectHttp(server, config as McpHttpServerConfig);
        await Promise.all([refreshServerTools(server), refreshServerResources(server)]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        server.status.state = "error";
        server.status.error = msg;
        printWarning(`Failed to connect to MCP server "${name}": ${msg}`);
      }
    };

    connectPromises.push(
      Promise.race([
        connectAndDiscover(),
        new Promise<void>((res) => {
          const t = setTimeout(() => {
            if (server.status.state === "connecting") {
              server.status.state = "error";
              server.status.error = "Connection timed out (15s)";
              printWarning(`MCP server "${name}" connection timed out.`);
            }
            res();
          }, 15_000);
          t.unref();
        }),
      ])
    );
  }

  await Promise.allSettled(connectPromises);
}

export function getMcpTools(): Tool[] {
  const tools: Tool[] = [];
  for (const server of servers.values()) {
    if (server.status.state !== "connected") continue;
    for (const mcpTool of server.tools) {
      tools.push(bridgeMcpTool(server, mcpTool));
    }
  }
  return tools;
}

export function getMcpServerStatus(): McpServerStatus[] {
  return Array.from(servers.values()).map((s) => ({ ...s.status }));
}

export function getMcpInstructions(): string | undefined {
  const instructions: string[] = [];
  for (const server of servers.values()) {
    if (server.status.state === "connected" && server.instructions) {
      instructions.push(`[MCP Server "${server.name}" instructions]\n${server.instructions}`);
    }
  }
  return instructions.length > 0 ? instructions.join("\n\n") : undefined;
}

export async function shutdownMcpServers(): Promise<void> {
  const shutdownPromises: Promise<void>[] = [];

  for (const [, server] of servers) {
    if (server.connection?.type === "stdio") {
      const conn = server.connection;
      const proc = conn.process;
      for (const [, pending] of conn.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("MCP server shutting down"));
      }
      conn.pendingRequests.clear();

      shutdownPromises.push(
        new Promise<void>((res) => {
          const killTimeout = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* */ } res(); }, 5_000);
          killTimeout.unref();
          proc.once("exit", () => { clearTimeout(killTimeout); res(); });
          try { proc.kill("SIGTERM"); } catch { res(); }
        })
      );
    }
    server.status.state = "disconnected";
    server.status.error = "Shut down";
  }

  await Promise.allSettled(shutdownPromises);
  servers.clear();
  initialized = false;
}
