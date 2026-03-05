/**
 * Agent Worker — child process entry point spawned by the Gateway via
 * `child_process.fork()`.
 *
 * Architecture:
 * ```
 *   ┌──────────┐   fork() IPC channel   ┌──────────────┐
 *   │ Gateway  │ ◄─────────────────────► │ Agent Worker │
 *   │ (host)   │   JSON messages         │ (child)      │
 *   └──────────┘                         └──────────────┘
 * ```
 *
 * Responsibilities:
 *   1. Initializes the coding agent (config, context, tools, MCP, skills)
 *   2. Listens for IPC messages from the gateway (GatewayMessage types)
 *   3. Processes user messages through the agenticLoop via runSession()
 *   4. Sends results back to the gateway as WorkerMessage types
 *   5. Sends `ready` when initialization is complete
 *   6. Sends `busy`/`idle` to signal processing state
 *
 * @module agent-worker
 */

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { loadConfig, getConfig } from "../config/config.js";
import { createContext } from "../core/context.js";
import { getAllTools, registerMcpTools } from "../tools/index.js";
import { spawnAgent, listRunningAgents } from "../core/agent.js";
import {
  loadMcpServers,
  getMcpTools,
  getMcpInstructions,
  shutdownMcpServers,
  getMcpServerStatus,
} from "../core/mcp-client.js";
import { loadProjectMemory, loadSkills, getSkillDescriptions } from "../config/skills.js";
import { runSession } from "../session/session-runner.js";
import {
  estimateTokens,
  microCompact,
  autoCompact,
} from "../core/compaction.js";
import {
  saveSession,
  listSessions,
  loadSession,
  deleteSession,
} from "../session/session.js";
import { BaseOutputPort } from "../ports/io-port.js";
import type { InputPort, IOPort, UserMessage, OutputPort } from "../ports/io-port.js";
import type { Tool, ToolContext, ToolResult, Message } from "../core/types.js";
import type {
  GatewayMessage,
  GatewayUserMessage,
  GatewayCommand,
  WorkerMessage,
} from "./ipc-protocol.js";
import { isGatewayMessage } from "./ipc-protocol.js";

// ═══════════════════════════════════════════════════════════════════════════════
// IPC Send Helper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a WorkerMessage to the gateway via the IPC channel.
 *
 * Guards against `process.send` being undefined — which happens when the
 * module is run directly (not as a forked child). In that case, messages
 * are logged to stderr as a debugging aid.
 */
function sendToGateway(message: WorkerMessage): void {
  if (typeof process.send === "function") {
    process.send(message);
  } else {
    // Not running as a forked child — log for debugging.
    console.error(
      `[agent-worker] No IPC channel. Would send: ${JSON.stringify(message).slice(0, 200)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC Output Port
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * OutputPort that forwards every event to the gateway as a WorkerMessage
 * over the Node.js IPC channel. Each OutputPort method maps 1:1 to a
 * WorkerMessage type.
 *
 * The optional `requestId` is threaded through from the originating
 * GatewayUserMessage so the gateway can correlate responses.
 */
class IpcOutputPort extends BaseOutputPort {
  /** Correlation ID from the current GatewayUserMessage. */
  currentRequestId: string | undefined;

  setRequestId(requestId: string | undefined): void {
    this.currentRequestId = requestId;
  }

  onAssistantText(text: string): void {
    sendToGateway({
      type: "assistant_text",
      requestId: this.currentRequestId,
      text,
    });
  }

  onAssistantTextComplete(fullText: string): void {
    sendToGateway({
      type: "assistant_text_complete",
      requestId: this.currentRequestId,
      text: fullText,
    });
  }

  onToolUse(toolName: string, input: Record<string, unknown>): void {
    sendToGateway({
      type: "tool_use",
      requestId: this.currentRequestId,
      toolName,
      input,
    });
  }

  onToolResult(
    toolName: string,
    result: ToolResult,
    durationMs?: number
  ): void {
    sendToGateway({
      type: "tool_result",
      requestId: this.currentRequestId,
      toolName,
      result,
      durationMs,
    });
  }

  onTurnComplete(stopReason: string): void {
    sendToGateway({
      type: "turn_complete",
      requestId: this.currentRequestId,
      stopReason,
    });
  }

  onError(error: string): void {
    sendToGateway({
      type: "error",
      requestId: this.currentRequestId,
      error,
    });
  }

  onApiCallStart(): void {
    sendToGateway({
      type: "api_call_start",
      requestId: this.currentRequestId,
    });
  }

  onApiCallEnd(
    durationMs: number,
    usage?: { inputTokens: number; outputTokens: number }
  ): void {
    sendToGateway({
      type: "api_call_end",
      requestId: this.currentRequestId,
      durationMs,
      usage,
    });
  }

  onEvalStart(round: number, judgeCount: number): void {
    sendToGateway({
      type: "eval_start",
      requestId: this.currentRequestId,
      round,
      judgeCount,
    });
  }

  onEvalJudgeVerdict(
    verdict: { judgeName: string; isComplete: boolean; reasoning: string },
    round: number
  ): void {
    sendToGateway({
      type: "eval_judge_verdict",
      requestId: this.currentRequestId,
      verdict,
      round,
    });
  }

  onEvalComplete(
    passed: boolean,
    round: number,
    refinementPrompt?: string
  ): void {
    sendToGateway({
      type: "eval_complete",
      requestId: this.currentRequestId,
      passed,
      round,
      refinementPrompt,
    });
  }

  info(message: string): void {
    sendToGateway({
      type: "info",
      requestId: this.currentRequestId,
      message,
    });
  }

  warn(message: string): void {
    sendToGateway({
      type: "warn",
      requestId: this.currentRequestId,
      message,
    });
  }

  success(label: string, detail?: string): void {
    sendToGateway({
      type: "success",
      requestId: this.currentRequestId,
      label,
      detail,
    });
  }

  async close(): Promise<void> {
    // No-op — the IPC channel is managed by the parent process.
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC Input Port
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * InputPort that yields UserMessage objects from incoming GatewayUserMessage
 * IPC messages. Uses an async queue pattern: the IPC `message` handler
 * pushes messages into a buffer, and the async generator yields them
 * one at a time.
 *
 * The generator completes when `close()` is called (shutdown).
 */
class IpcInputPort implements InputPort {
  /**
   * Buffer of pending user messages waiting to be consumed by the
   * session runner's `for await` loop.
   */
  private buffer: GatewayUserMessage[] = [];

  /**
   * Resolve function for the Promise that the generator awaits when
   * the buffer is empty. Set when the generator is waiting for input.
   */
  private waiter: (() => void) | null = null;

  /** Whether the input port has been closed. */
  private closed = false;

  /**
   * Push a user message into the buffer. Called by the IPC message handler.
   */
  enqueue(msg: GatewayUserMessage): void {
    this.buffer.push(msg);
    if (this.waiter) {
      this.waiter();
      this.waiter = null;
    }
  }

  async *messages(): AsyncIterable<UserMessage> {
    while (!this.closed) {
      // Drain any buffered messages
      while (this.buffer.length > 0) {
        const msg = this.buffer.shift()!;
        yield {
          text: msg.text,
          images: msg.images,
          metadata: {
            ...msg.metadata,
            requestId: msg.requestId,
          },
        };
      }

      // If closed during drain, exit
      if (this.closed) break;

      // Wait for the next message or close signal
      await new Promise<void>((resolve) => {
        // Check if a message arrived or we were closed while setting up
        if (this.buffer.length > 0 || this.closed) {
          resolve();
        } else {
          this.waiter = resolve;
        }
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    // Wake the generator if it's waiting
    if (this.waiter) {
      this.waiter();
      this.waiter = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC IO Port (combined)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Combined IOPort for IPC communication. Wraps IpcInputPort and
 * IpcOutputPort into the IOPort interface expected by runSession().
 */
class IpcIOPort implements IOPort {
  readonly name = "ipc-worker";
  readonly input: IpcInputPort;
  readonly output: IpcOutputPort;

  constructor() {
    this.input = new IpcInputPort();
    this.output = new IpcOutputPort();
  }

  async close(): Promise<void> {
    await this.input.close();
    await this.output.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// System Prompt Builder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the system prompt dynamically from the registered tools, MCP
 * instructions, project memory, and skills — mirrors telegram.ts's
 * `getSystemPrompt()` but with gateway-appropriate instructions.
 */
function getSystemPrompt(cwd: string, tools: readonly Tool[]): string {
  const toolList = tools
    .map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`)
    .join("\n");

  let prompt = `You are a coding assistant with access to tools for reading, writing, and editing files, searching codebases, and executing commands.

You have access to the following tools:
${toolList}

Important rules:
- Always read a file before editing or overwriting it
- Use Glob and Grep to explore the codebase before making changes
- Be concise in your responses
- All tool calls are auto-approved — no permission prompts

Current working directory: ${cwd}
Platform: ${process.platform}
Date: ${new Date().toISOString()}
`;

  const mcpTools = getMcpTools();
  if (mcpTools.length > 0) {
    const mcpToolLines = mcpTools.map(
      (t) => `- ${t.name}: ${t.description.split("\n")[0]}`
    );
    prompt += `\nMCP tools:\n${mcpToolLines.join("\n")}\n`;
  }

  const mcpInstr = getMcpInstructions();
  if (mcpInstr) prompt += `\n${mcpInstr}\n`;

  const memory = loadProjectMemory(cwd);
  if (memory) prompt += memory;

  const skillDescs = getSkillDescriptions(cwd);
  if (skillDescs) prompt += skillDescs;

  return prompt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// .env / Secrets Loading — handled by loadConfig() → loadAllEnv()
// No manual env loading needed here. The worker inherits process.env from
// the gateway (which already called loadAllEnv()), and loadConfig() calls
// loadAllEnv() again as a safety net (idempotent).
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Command Handler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Shared mutable state for command handling. Populated by `main()` once
 * initialization is complete. Commands need access to the session's
 * messages array, context, config, etc.
 */
interface WorkerState {
  messages: Message[];
  context: ToolContext;
  systemPrompt: string;
  sessionId: string;
  turnCount: number;
  startTime: number;
}

let workerState: WorkerState | null = null;

/**
 * Handle a slash command forwarded from the gateway.
 *
 * Returns a pre-formatted result string. Some commands modify the worker's
 * state (e.g., `/clear` resets messages, `/model` switches the model).
 *
 * Commands that are inherently terminal-specific (e.g., `/undo` which
 * shells out to git) are still supported — they execute in the worker's
 * process context.
 */
async function handleWorkerCommand(command: string, requestId?: string): Promise<{
  text: string;
  isError?: boolean;
}> {
  if (!workerState) {
    return { text: "Worker not initialized yet.", isError: true };
  }

  const { messages, context, systemPrompt } = workerState;
  const config = getConfig();
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/help": {
      const commands = [
        "/help           — Show this help message",
        "/clear          — Clear conversation history",
        "/compact        — Compact context (--force to compact below threshold)",
        "/tokens         — Show estimated token count",
        "/model <name>   — Switch to a different model",
        "/smallmodel <n> — Switch small model (compaction/exploration)",
        "/save           — Save current session to disk",
        "/sessions       — List saved sessions",
        "/resume <id|#>  — Resume a saved session",
        "/mcp            — Show MCP server status",
        "/memory         — Show loaded project memory",
        "/skills         — List available skills",
        "/agents [id]    — Show background agent status",
        "/cache          — Show explore cache statistics",
        "/history        — Show recent prompt history",
        "/undo           — Stash uncommitted file changes",
        "/retry          — Re-send last prompt",
        "/debug          — Toggle debug mode (log all LLM interactions)",
        "/reload         — Hot restart worker (gateway)",
        "/status         — Show gateway status (gateway)",
        "/quit           — Exit (gateway)",
      ];
      return { text: commands.join("\n") };
    }

    case "/clear": {
      // Save current session before clearing
      const state = {
        turnCount: workerState.turnCount,
        totalApiDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        history: [] as Array<{ timestamp: number; text: string }>,
      };
      saveSession(
        workerState.sessionId,
        messages,
        state,
        context.cwd,
        config.model,
        estimateTokens(messages, systemPrompt.length),
      );
      // Reset state
      messages.length = 0;
      workerState.turnCount = 0;
      context.readFileState.clear();
      context.exploreCache?.clear();
      return { text: "✅ Conversation cleared. Starting fresh." };
    }

    case "/compact": {
      const force = arg === "--force" || arg === "-f";
      const tokens = estimateTokens(messages, systemPrompt.length);
      if (!force && tokens < config.compactionThreshold) {
        return {
          text: `Context is ${tokens.toLocaleString()} tokens (threshold: ${config.compactionThreshold.toLocaleString()}). Use /compact --force to compact anyway.`,
        };
      }
      if (messages.length < 4) {
        return { text: "Not enough messages to compact." };
      }
      const before = estimateTokens(messages, systemPrompt.length);
      await autoCompact(messages, systemPrompt);
      const after = estimateTokens(messages, systemPrompt.length);
      const saved = before - after;
      return {
        text: `✅ Compacted: ${before.toLocaleString()} → ${after.toLocaleString()} tokens (saved ${saved.toLocaleString()})`,
      };
    }

    case "/tokens": {
      const tokens = estimateTokens(messages, systemPrompt.length);
      return {
        text: `📊 ${tokens.toLocaleString()} estimated tokens | ${messages.length} messages | Model: ${config.model}`,
      };
    }

    case "/model": {
      if (!arg) {
        return { text: `Current model: ${config.model}` };
      }
      (config as any).model = arg;
      return { text: `✅ Model switched to: ${arg}` };
    }

    case "/smallmodel": {
      if (!arg) {
        return { text: `Current small model: ${config.smallModel}` };
      }
      (config as any).smallModel = arg;
      return { text: `✅ Small model switched to: ${arg}` };
    }

    case "/save": {
      const tokens = estimateTokens(messages, systemPrompt.length);
      const state = {
        turnCount: workerState.turnCount,
        totalApiDurationMs: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        history: [] as Array<{ timestamp: number; text: string }>,
      };
      const ok = saveSession(
        workerState.sessionId,
        messages,
        state,
        context.cwd,
        config.model,
        tokens,
        context.exploreCache?.serialize(),
      );
      return ok
        ? { text: `✅ Session saved: ${workerState.sessionId}` }
        : { text: "Failed to save session.", isError: true };
    }

    case "/sessions": {
      const sessions = listSessions();
      if (sessions.length === 0) {
        return { text: "No saved sessions." };
      }
      const lines = sessions.slice(0, 15).map((s, i) => {
        const date = new Date(s.updatedAt).toLocaleString();
        const preview = s.preview ? ` — ${s.preview.slice(0, 50)}` : "";
        return `  ${i + 1}. ${s.id.slice(0, 8)} | ${date} | ${s.messageCount} msgs${preview}`;
      });
      return { text: `📋 Saved sessions:\n${lines.join("\n")}` };
    }

    case "/mcp": {
      const statuses = getMcpServerStatus();
      if (statuses.length === 0) {
        return { text: "No MCP servers configured." };
      }
      const lines = statuses.map((s) => {
        const icon = s.state === "connected" ? "🟢" : s.state === "error" ? "🔴" : "🟡";
        return `  ${icon} ${s.name} (${s.type}) — ${s.toolCount} tools${s.error ? ` ⚠ ${s.error}` : ""}`;
      });
      return { text: `🔌 MCP Servers:\n${lines.join("\n")}` };
    }

    case "/memory": {
      const memory = loadProjectMemory(context.cwd);
      if (!memory) {
        return { text: "No project memory loaded (no CLAUDE.md found)." };
      }
      const preview = memory.split("\n").slice(0, 40).join("\n");
      return { text: `📝 Project Memory:\n${preview}` };
    }

    case "/skills": {
      const descs = getSkillDescriptions(context.cwd);
      if (!descs) {
        return { text: "No skills loaded." };
      }
      return { text: `🎯 Skills:\n${descs}` };
    }

    case "/agents": {
      const agents = listRunningAgents();
      if (agents.length === 0) {
        return { text: "No background agents." };
      }
      if (arg) {
        const agent = agents.find((a) => a.id === arg || a.id.startsWith(arg));
        if (!agent) {
          return { text: `Agent "${arg}" not found.`, isError: true };
        }
        const status = agent.done ? "done" : "running";
        const resultPreview = agent.result
          ? agent.result.slice(0, 5000)
          : "(no result yet)";
        return { text: `Agent ${agent.id}:\nStatus: ${status}\n\n${resultPreview}` };
      }
      const lines = agents.map((a) => {
        const icon = a.done ? "✅" : "🔄";
        const status = a.done ? "done" : "running";
        const preview = a.result ? ` — ${a.result.slice(0, 60)}` : "";
        return `  ${icon} ${a.id.slice(0, 8)} ${status}${preview}`;
      });
      return { text: `🤖 Background Agents:\n${lines.join("\n")}` };
    }

    case "/cache": {
      const cache = context.exploreCache;
      if (!cache) {
        return { text: "Explore cache not available." };
      }
      const stats = cache.getStats();
      return {
        text: [
          "📦 Explore Cache:",
          `  Entries: ${stats.size}`,
          `  Hits: ${stats.hits} | Misses: ${stats.misses}`,
          `  Hit rate: ${stats.hits + stats.misses > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) : 0}%`,
        ].join("\n"),
      };
    }

    case "/history": {
      // In gateway mode we don't maintain a separate history — show last user messages
      const userMsgs = messages
        .filter((m) => m.role === "user")
        .slice(-20);
      if (userMsgs.length === 0) {
        return { text: "No history yet." };
      }
      const lines = userMsgs.map((m, i) => {
        const text = typeof m.content === "string"
          ? m.content.slice(0, 60)
          : "(multipart)";
        return `  ${i + 1}. ${text}`;
      });
      return { text: `📜 Recent prompts:\n${lines.join("\n")}` };
    }

    case "/undo": {
      // Shell out to git stash
      const { execSync } = await import("child_process");
      try {
        const diff = execSync("git diff --stat", { cwd: context.cwd, encoding: "utf-8", timeout: 5000 });
        if (!diff.trim()) {
          return { text: "No uncommitted changes to stash." };
        }
        execSync("git stash push --include-untracked -m 'codingagent-undo'", {
          cwd: context.cwd,
          timeout: 10000,
        });
        return { text: `✅ Changes stashed.\n\n${diff}` };
      } catch (err) {
        return {
          text: `Failed to undo: ${err instanceof Error ? err.message : err}`,
          isError: true,
        };
      }
    }

    case "/retry": {
      // Find the last user message and re-submit it
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx < 0) {
        return { text: "No previous prompt to retry.", isError: true };
      }
      const lastMsg = messages[lastUserIdx];
      const retryText = typeof lastMsg.content === "string"
        ? lastMsg.content
        : "(multipart message — cannot retry)";
      // Remove everything from the last user message onward
      messages.splice(lastUserIdx);
      return { text: `🔄 Retrying: "${retryText.slice(0, 80)}…"\n(Re-submit this as a regular message)` };
    }

    case "/resume": {
      if (!arg) {
        return { text: "Usage: /resume <session-id or #number>", isError: true };
      }
      const sessions = listSessions();
      let targetId: string | null = null;
      if (arg.startsWith("#")) {
        const idx = parseInt(arg.slice(1), 10) - 1;
        if (idx >= 0 && idx < sessions.length) targetId = sessions[idx].id;
      } else {
        const match = sessions.find((s) => s.id === arg || s.id.startsWith(arg));
        if (match) targetId = match.id;
      }
      if (!targetId) {
        return { text: `Session "${arg}" not found.`, isError: true };
      }
      const session = loadSession(targetId);
      if (!session) {
        return { text: `Failed to load session ${targetId}.`, isError: true };
      }
      // Restore session state
      messages.length = 0;
      messages.push(...session.messages);
      workerState.sessionId = session.metadata.id;
      workerState.turnCount = session.sessionState.turnCount;
      if (session.metadata.model) {
        (config as any).model = session.metadata.model;
      }
      const resumeTokens = estimateTokens(messages, systemPrompt.length);
      return {
        text: `✅ Resumed session ${targetId.slice(0, 8)} — ${messages.length} messages, ${resumeTokens.toLocaleString()} tokens`,
      };
    }

    case "/delete-session": {
      if (!arg) {
        return { text: "Usage: /delete-session <session-id>", isError: true };
      }
      const sessions = listSessions();
      const match = sessions.find((s) => s.id === arg || s.id.startsWith(arg));
      if (!match) {
        return { text: `Session "${arg}" not found.`, isError: true };
      }
      if (match.id === workerState.sessionId) {
        return { text: "Cannot delete the current session.", isError: true };
      }
      const ok = deleteSession(match.id);
      return ok
        ? { text: `✅ Deleted session ${match.id.slice(0, 8)}` }
        : { text: `Failed to delete session ${match.id}.`, isError: true };
    }

    case "/debug": {
      const { toggleDebug, isDebugEnabled, getDebugLogPath } = await import("../core/debug.js");
      const result = toggleDebug(workerState.sessionId);
      if (result.enabled) {
        return {
          text: [
            "🔍 Debug mode: ON",
            `Logging to: ${result.logPath}`,
            "Each LLM interaction is saved as a separate timestamped JSON file.",
            "Use /debug again to turn off.",
          ].join("\n"),
        };
      } else {
        const logPath = getDebugLogPath();
        return {
          text: `🔍 Debug mode: OFF${logPath ? `\nDebug logs: ${logPath}` : ""}`,
        };
      }
    }

    default:
      return { text: `Unknown command: ${cmd}`, isError: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── Guard: must be running as a forked child ──
  if (typeof process.send !== "function") {
    console.error(
      "[agent-worker] ERROR: This module must be run as a child process via child_process.fork().\n" +
        "  process.send is not available — IPC communication is disabled.\n" +
        "  The worker will attempt to initialize but cannot communicate with a gateway."
    );
    // Continue anyway so the worker can be tested standalone (messages go to stderr).
  }

  // ── Load config ──
  const config = loadConfig();

  if (!config.apiKey) {
    sendToGateway({
      type: "error",
      error:
        "ANTHROPIC_API_KEY is not set. Set it in the environment or ~/.claude/settings.json.",
      fatal: true,
    });
    process.exit(1);
  }

  // ── Create tool context ──
  const context: ToolContext = createContext();
  context.spawnAgent = (prompt, options) =>
    spawnAgent(prompt, options, context);

  // ── Load MCP servers ──
  try {
    await loadMcpServers(context.cwd);
    const mcpTools = getMcpTools();
    if (mcpTools.length > 0) registerMcpTools(mcpTools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendToGateway({
      type: "warn",
      message: `Failed to load MCP servers: ${msg}`,
    });
  }

  // ── Load skills ──
  loadSkills(context.cwd);

  // ── Resolve tools ──
  const tools = getAllTools();

  // ── Build system prompt ──
  const systemPrompt = getSystemPrompt(context.cwd, tools);

  // ── Create IPC port ──
  const port = new IpcIOPort();

  // ── Set up IPC message handler ──
  process.on("message", (raw: unknown) => {
    if (!isGatewayMessage(raw)) {
      console.error(
        `[agent-worker] Received invalid IPC message: ${JSON.stringify(raw).slice(0, 200)}`
      );
      return;
    }

    const msg = raw as GatewayMessage;

    switch (msg.type) {
      case "user_message": {
        // Set the requestId on the output port so all responses for this
        // message carry the correlation ID.
        port.output.setRequestId(msg.requestId);

        // Signal that we're busy processing
        sendToGateway({ type: "busy", requestId: msg.requestId });

        // Enqueue for the session runner's input stream
        port.input.enqueue(msg);
        break;
      }

      case "abort": {
        // Abort the current operation by firing the abort controller,
        // then create a new one so subsequent operations can proceed.
        context.abortController.abort();
        context.abortController = new AbortController();

        sendToGateway({
          type: "info",
          requestId: msg.requestId,
          message: "Processing aborted.",
        });
        break;
      }

      case "command": {
        // Execute a slash command forwarded from the gateway.
        const cmdMsg = msg as GatewayCommand;
        port.output.setRequestId(cmdMsg.requestId);
        sendToGateway({ type: "busy", requestId: cmdMsg.requestId });

        console.error(
          `[agent-worker] Command: ${cmdMsg.command} (from ${cmdMsg.metadata.transport}:${cmdMsg.metadata.chatId})`
        );

        (async () => {
          try {
            const result = await handleWorkerCommand(cmdMsg.command, cmdMsg.requestId);
            sendToGateway({
              type: "command_result",
              requestId: cmdMsg.requestId,
              text: result.text,
              isError: result.isError,
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            sendToGateway({
              type: "command_result",
              requestId: cmdMsg.requestId,
              text: `Command error: ${errMsg}`,
              isError: true,
            });
          } finally {
            sendToGateway({ type: "idle", requestId: cmdMsg.requestId });
          }
        })();
        break;
      }

      case "shutdown": {
        // Graceful shutdown: close ports, shut down MCP, exit.
        (async () => {
          try {
            await port.close();
            await shutdownMcpServers();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[agent-worker] Shutdown error: ${errMsg}`);
          } finally {
            process.exit(0);
          }
        })();
        break;
      }
    }
  });

  // ── Print startup info (useful for debugging) ──
  console.error(
    `[agent-worker] Initialized — model: ${config.model}, cwd: ${context.cwd}, tools: ${tools.length}`
  );

  // ── Signal ready ──
  sendToGateway({ type: "ready" });

  // ── Initialize worker state for command handling ──
  // The messages array is shared with runSession — commands that modify
  // it (e.g., /clear, /resume) directly affect the session.
  const sessionMessages: Message[] = [];
  const { generateSessionId } = await import("../session/session.js");
  workerState = {
    messages: sessionMessages,
    context,
    systemPrompt,
    sessionId: generateSessionId(),
    turnCount: 0,
    startTime: Date.now(),
  };

  // ── Run the session ──
  // runSession consumes port.input.messages() in a for-await loop.
  // It runs indefinitely until the input port is closed (shutdown).
  await runSession({
    port,
    messages: sessionMessages,
    systemPrompt,
    tools,
    context,
    config,
    onUserMessage: async (text, metadata) => {
      const requestId = metadata?.requestId as string | undefined;
      const chatId = metadata?.chatId ?? "?";
      const transport = metadata?.transport ?? "unknown";
      console.error(
        `[agent-worker] [${new Date().toISOString()}] 📩 ${transport}:${chatId}: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`
      );
      // Update requestId for this message's responses
      port.output.setRequestId(requestId);
      return text;
    },
    onTurnEnd: async (_messages, usage) => {
      console.error(
        `[agent-worker]   └─ tokens: ${usage.inputTokens}→${usage.outputTokens}  api: ${Math.round(usage.apiDurationMs)}ms`
      );
      // Update worker state
      if (workerState) workerState.turnCount++;
      // Signal idle after processing completes
      sendToGateway({ type: "idle", requestId: port.output.currentRequestId });
      return undefined;
    },
  });
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  sendToGateway({
    type: "error",
    error: `Agent worker fatal error: ${msg}`,
    fatal: true,
  });
  console.error("[agent-worker] Fatal error:", err);
  process.exit(1);
});
