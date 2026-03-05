#!/usr/bin/env node
/**
 * Gateway — the long-running host process that manages transport connections
 * and delegates agent work to a child process via `child_process.fork()`.
 *
 * Architecture:
 * ```
 *   ┌───────────────────────────────────────────────────────────────────┐
 *   │                          Gateway (host)                          │
 *   │                                                                  │
 *   │  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
 *   │  │ Telegram │  │  Teams   │  │ Terminal │  ← Transports          │
 *   │  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
 *   │       │             │             │                              │
 *   │       └─────────────┼─────────────┘                              │
 *   │                     ▼                                            │
 *   │              ┌─────────────┐                                     │
 *   │              │  Transport  │                                     │
 *   │              │   Bridge    │                                     │
 *   │              └──────┬──────┘                                     │
 *   │                     │ IPC (fork channel)                         │
 *   │              ┌──────┴──────┐                                     │
 *   │              │   Worker    │                                     │
 *   │              │  Manager    │                                     │
 *   │              └──────┬──────┘                                     │
 *   └─────────────────────┼────────────────────────────────────────────┘
 *                         │ fork()
 *                  ┌──────┴──────┐
 *                  │ Agent Worker│  (child process — heavy lifting)
 *                  │ agent-worker│
 *                  └─────────────┘
 * ```
 *
 * Key behaviors:
 * - **Stays running permanently** — transport connections survive worker restarts
 * - **Hot-reloading** — `/reload` command restarts the worker without dropping
 *   Telegram polling or Teams webhook connections
 * - **Lightweight** — imports only IPC types, transport ports, and child_process;
 *   no agent code, tools, config, or heavy dependencies
 * - **Message queueing** — buffers inbound user messages while the worker is
 *   busy or restarting, drains on `idle`
 * - **Auto-respawn** — worker crashes trigger automatic restart after 1s delay
 *
 * Usage:
 *   npm run gateway                  # auto-detect transports from env vars
 *   npm run gateway -- --telegram    # force Telegram transport
 *   npm run gateway -- --teams       # force Teams transport
 *   npm run gateway -- --telegram --teams  # both
 *
 * @module gateway
 */

import { fork, type ChildProcess, spawn as cpSpawn } from "child_process";
import { readFileSync, watch as fsWatch, type FSWatcher } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  GatewayMessage,
  GatewayUserMessage,
  GatewayCommand,
  WorkerMessage,
  UserMessageMetadata,
  TransportSource,
} from "./ipc-protocol.js";
import { isWorkerMessage } from "./ipc-protocol.js";
import { TelegramIOPort, type TelegramPortConfig } from "../ports/telegram-port.js";
import { TeamsIOPort, type TeamsPortConfig } from "../ports/teams-port.js";
import { TerminalIOPort } from "../ports/terminal-port.js";
import type { OutputPort } from "../ports/io-port.js";
import type { ImageAttachment } from "../ports/io-port.js";
import { loadAllEnv } from "../config/env.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Env Loading
// ═══════════════════════════════════════════════════════════════════════════════

// Load all env sources (idempotent). The gateway doesn't import config.ts to
// stay lightweight, but it still needs env vars (bot tokens, allowed chat IDs,
// etc.) to be populated before setting up transports.
loadAllEnv();

// ═══════════════════════════════════════════════════════════════════════════════
// Agent Worker Manager
// ═══════════════════════════════════════════════════════════════════════════════

/** Resolve the path to agent-worker.js relative to this file (siblings in dist/). */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = resolve(__dirname, "agent-worker.js");

/**
 * Manages the Agent Worker child process lifecycle.
 *
 * Responsibilities:
 * - Spawn the worker via `child_process.fork()` with IPC channel
 * - Wait for `{ type: "ready" }` before forwarding messages
 * - Queue messages while the worker is busy or restarting
 * - Auto-respawn on crash after a 1-second delay
 * - Graceful shutdown and hot-reload support
 */
class AgentWorkerManager {
  /** The current worker child process (null if not spawned). */
  private worker: ChildProcess | null = null;

  /** Whether the worker has signalled `ready`. */
  private ready = false;

  /** Whether the worker is currently processing a message. */
  private busy = false;

  /** Queue of messages to send once the worker becomes idle. */
  private messageQueue: (GatewayUserMessage | GatewayCommand)[] = [];

  /** Registered handlers for worker → gateway messages. */
  private messageHandlers: Array<(msg: WorkerMessage) => void> = [];

  /** Whether the manager is in the process of shutting down. */
  private shuttingDown = false;

  /** Whether a reload is in progress. */
  private reloading = false;

  /** Spawn count for logging. */
  private spawnCount = 0;

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Spawn the agent worker via `child_process.fork()`.
   *
   * Resolves when the worker sends `{ type: "ready" }`. Rejects if the
   * worker exits before becoming ready.
   */
  spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.ready = false;
      this.busy = false;
      this.spawnCount++;
      const spawnId = this.spawnCount;

      log(`Spawning worker #${spawnId} → ${WORKER_PATH}`);

      this.worker = fork(WORKER_PATH, [], {
        stdio: ["pipe", "inherit", "inherit", "ipc"],
        env: { ...process.env },
      });

      const onReady = (msg: unknown) => {
        if (!isWorkerMessage(msg)) return;
        if (msg.type === "ready") {
          this.ready = true;
          log(`Worker #${spawnId} ready ✓`);
          resolve();
          // Don't remove the listener — keep forwarding messages
        }
        // Forward all messages (including the ready) to registered handlers
        this.handleWorkerMessage(msg);
      };

      this.worker.on("message", onReady);

      this.worker.on("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        log(`Worker #${spawnId} exited (${reason})`);

        this.worker = null;
        const wasReady = this.ready;
        this.ready = false;
        this.busy = false;

        if (!wasReady) {
          reject(new Error(`Worker exited before ready (${reason})`));
        }

        // Auto-respawn only if the worker was previously ready (i.e., it
        // crashed after successful startup) and we're not shutting down or
        // in the middle of a reload.
        if (wasReady && !this.shuttingDown && !this.reloading) {
          log("Auto-respawning worker in 1s…");
          setTimeout(() => {
            if (!this.shuttingDown && !this.reloading) {
              this.spawn().catch((err) => {
                log(`Auto-respawn failed: ${err instanceof Error ? err.message : err}`);
              });
            }
          }, 1000);
        }
      });

      this.worker.on("error", (err) => {
        log(`Worker #${spawnId} error: ${err.message}`);
      });
    });
  }

  /**
   * Hot-reload: gracefully stop the current worker and spawn a new one.
   *
   * Transport connections are not affected — only the worker process
   * restarts. Queued messages are preserved and sent to the new worker.
   */
  async reload(): Promise<void> {
    this.reloading = true;
    log("Reloading worker…");

    try {
      // Gracefully shut down the current worker
      if (this.worker && this.ready) {
        this.send({ type: "shutdown" });

        // Wait for the worker to exit (with a timeout).
        // Use a clearable timer to avoid dangling Promise rejections.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // Force kill if graceful shutdown times out
            log("Worker did not exit gracefully — force killing");
            this.worker?.kill("SIGKILL");
            // Resolve regardless — we'll spawn a new worker next
            resolve();
          }, 5000);

          if (!this.worker) {
            clearTimeout(timer);
            resolve();
            return;
          }

          this.worker.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } else if (this.worker) {
        // Worker exists but not ready — just kill it
        this.worker.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (!this.worker) {
            resolve();
            return;
          }
          this.worker.once("exit", () => resolve());
        });
      }

      // Small delay on Windows to let the OS fully clean up the old process
      // before spawning a new one (avoids port/handle conflicts).
      if (process.platform === "win32") {
        await new Promise<void>((r) => setTimeout(r, 200));
      }

      // Spawn a fresh worker
      await this.spawn();
      log("Worker reloaded successfully ✓");
    } finally {
      this.reloading = false;
    }
  }

  /**
   * Send a message to the worker over the IPC channel.
   *
   * For `user_message` and `command` messages: if the worker is not ready
   * or is busy, the message is queued and will be sent when the worker
   * becomes idle.
   *
   * For control messages (`shutdown`, `abort`): sent immediately.
   */
  send(msg: GatewayMessage): void {
    if (msg.type === "user_message" || msg.type === "command") {
      if (!this.ready || this.busy) {
        log(`Queueing ${msg.type} (ready=${this.ready}, busy=${this.busy}): "${(msg.type === "user_message" ? msg.text : (msg as GatewayCommand).command).slice(0, 60)}…"`);
        this.messageQueue.push(msg);
        return;
      }
    }

    if (!this.worker) {
      if (msg.type === "user_message" || msg.type === "command") {
        this.messageQueue.push(msg);
        log(`No worker — ${msg.type} queued`);
      }
      return;
    }

    this.worker.send(msg);
  }

  /**
   * Register a handler for messages from the worker.
   *
   * Multiple handlers can be registered — all are called for each message
   * (fan-out to multiple transports).
   */
  onMessage(handler: (msg: WorkerMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Gracefully shut down the worker and prevent auto-respawn.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.worker) {
      if (this.ready) {
        this.send({ type: "shutdown" });
      }

      await Promise.race([
        new Promise<void>((resolve) => {
          if (!this.worker) {
            resolve();
            return;
          }
          this.worker.once("exit", () => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);

      // Force kill if still alive
      if (this.worker) {
        this.worker.kill("SIGKILL");
        this.worker = null;
      }
    }
  }

  /** Get the current worker status for the `/status` command. */
  getStatus(): { ready: boolean; busy: boolean; queueLength: number; pid: number | null; reloading: boolean } {
    return {
      ready: this.ready,
      busy: this.busy,
      queueLength: this.messageQueue.length,
      pid: this.worker?.pid ?? null,
      reloading: this.reloading,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Handle a validated WorkerMessage from the child process.
   * Updates internal state (busy/idle) and forwards to registered handlers.
   */
  private handleWorkerMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case "busy":
        this.busy = true;
        log(`Worker busy (request: ${msg.requestId ?? "?"})`);
        break;

      case "idle":
        this.busy = false;
        log(`Worker idle (request: ${msg.requestId ?? "?"})`);
        // Drain one queued message
        this.drainQueue();
        break;

      case "ready":
        // Already handled in spawn() — drain queue in case messages
        // accumulated before the worker was ready
        this.drainQueue();
        break;
    }

    // Forward to all registered handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(msg);
      } catch (err) {
        log(`Message handler error: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Send the next queued message to the worker, if ready and idle.
   */
  private drainQueue(): void {
    if (!this.ready || this.busy || this.messageQueue.length === 0) return;

    const next = this.messageQueue.shift()!;
    const preview = next.type === "user_message" ? next.text : (next as GatewayCommand).command;
    log(`Draining queue → "${preview.slice(0, 60)}…" (${this.messageQueue.length} remaining)`);
    this.worker?.send(next);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transport Handler Interface
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A transport handler receives WorkerMessages and sends them to the
 * appropriate transport (Telegram, Teams, etc.). Each transport registers
 * a handler with the TransportBridge.
 */
interface TransportHandler {
  /** Human-readable name for logging. */
  name: string;
  /**
   * Handle a WorkerMessage by forwarding it to the transport's output.
   * The handler is responsible for routing based on chatId / requestId.
   */
  handleWorkerMessage(msg: WorkerMessage): void | Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Transport Bridge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Routes messages between transports and the agent worker.
 *
 * Inbound: user messages from any transport → worker (via AgentWorkerManager)
 * Outbound: worker messages → correct transport (based on requestId tracking)
 */
class TransportBridge {
  private readonly workerManager: AgentWorkerManager;
  private readonly transports = new Map<string, TransportHandler>();

  /**
   * Maps requestId → transport name, so worker responses are routed back
   * to the transport that originated the request.
   */
  private readonly requestOrigin = new Map<string, string>();

  /** Counter for generating unique request IDs. */
  private requestCounter = 0;

  constructor(workerManager: AgentWorkerManager) {
    this.workerManager = workerManager;

    // Register ourselves as the handler for worker messages
    this.workerManager.onMessage((msg) => this.routeToTransport(msg));
  }

  /**
   * Register a transport handler. The handler will receive worker messages
   * that originated from its transport.
   */
  registerTransport(name: string, handler: TransportHandler): void {
    this.transports.set(name, handler);
    log(`Transport registered: ${name}`);
  }

  /**
   * Route a user message from a transport to the agent worker.
   *
   * Assigns a unique requestId for correlation and records which transport
   * originated the request so responses can be routed back.
   *
   * @param text - The user's message text
   * @param metadata - Transport-specific metadata (chatId, transport, etc.)
   * @returns The assigned requestId
   */
  routeToWorker(text: string, metadata: UserMessageMetadata, images?: ImageAttachment[]): string {
    const requestId = `gw-${++this.requestCounter}-${Date.now()}`;

    // Record which transport this request came from
    this.requestOrigin.set(requestId, metadata.transport);

    const msg: GatewayUserMessage = {
      type: "user_message",
      requestId,
      text,
      metadata,
      images,
    };

    this.workerManager.send(msg);
    return requestId;
  }

  /**
   * Route a slash command from a transport to the agent worker.
   *
   * Similar to `routeToWorker` but sends a `command` message instead of
   * a `user_message`. The worker executes the command and responds with
   * a `command_result` message.
   *
   * @param command - The full command string (e.g., "/model claude-sonnet-4-20250514")
   * @param metadata - Transport-specific metadata
   * @returns The assigned requestId
   */
  routeCommandToWorker(command: string, metadata: UserMessageMetadata): string {
    const requestId = `gw-${++this.requestCounter}-${Date.now()}`;

    // Record which transport this request came from
    this.requestOrigin.set(requestId, metadata.transport);

    const msg: GatewayCommand = {
      type: "command",
      requestId,
      command,
      metadata,
    };

    this.workerManager.send(msg);
    return requestId;
  }

  /**
   * Route a WorkerMessage to the correct transport based on the requestId.
   *
   * Falls back to broadcasting to all transports if no origin is tracked
   * (e.g., for `ready`, `busy`, `idle` messages that have no requestId).
   */
  routeToTransport(msg: WorkerMessage): void {
    const requestId = (msg as { requestId?: string }).requestId;

    // For terminal lifecycle messages (ready/busy/idle), we don't route
    // to transports — they're handled by the worker manager
    if (msg.type === "ready" || msg.type === "busy" || msg.type === "idle") {
      return;
    }

    if (requestId && this.requestOrigin.has(requestId)) {
      const transportName = this.requestOrigin.get(requestId)!;
      const handler = this.transports.get(transportName);

      if (handler) {
        Promise.resolve(handler.handleWorkerMessage(msg)).catch((err) => {
          log(`Transport ${transportName} error: ${err instanceof Error ? err.message : err}`);
        });
      }

      // Clean up origin tracking when the request is complete
      // (idle signals the end of processing for a request)
      // We don't clean up here — idle is handled above. Clean up on
      // turn_complete with stopReason=end_turn as a heuristic, or
      // just let the map grow (it's bounded by request count).
    } else {
      // No origin tracked — broadcast to all transports
      for (const [name, handler] of this.transports) {
        Promise.resolve(handler.handleWorkerMessage(msg)).catch((err) => {
          log(`Transport ${name} broadcast error: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
  }

  /**
   * Send a gateway-generated status/info message directly to a specific
   * transport's output, bypassing the worker. Used for `/status`, `/reload`
   * responses.
   */
  sendDirectToTransport(transport: string, text: string): void {
    const handler = this.transports.get(transport);
    if (handler) {
      const infoMsg: WorkerMessage = {
        type: "assistant_text_complete",
        text,
      };
      Promise.resolve(handler.handleWorkerMessage(infoMsg)).catch((err) => {
        log(`Direct send to ${transport} error: ${err instanceof Error ? err.message : err}`);
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message → OutputPort Router
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Route a WorkerMessage to an OutputPort — the reverse of what
 * IpcOutputPort does in agent-worker.ts.
 *
 * IpcOutputPort converts OutputPort calls → WorkerMessages (worker→gateway).
 * This function converts WorkerMessages → OutputPort calls (gateway→transport).
 */
async function routeWorkerMessageToOutput(
  msg: WorkerMessage,
  output: OutputPort,
): Promise<void> {
  switch (msg.type) {
    case "assistant_text":
      await output.onAssistantText(msg.text);
      break;

    case "assistant_text_complete":
      await output.onAssistantTextComplete(msg.text);
      break;

    case "tool_use":
      await output.onToolUse(msg.toolName, msg.input);
      break;

    case "tool_result":
      await output.onToolResult(msg.toolName, msg.result, msg.durationMs);
      break;

    case "turn_complete":
      await output.onTurnComplete(msg.stopReason);
      break;

    case "error":
      await output.onError(msg.error);
      break;

    case "api_call_start":
      await output.onApiCallStart();
      break;

    case "api_call_end":
      await output.onApiCallEnd(msg.durationMs, msg.usage);
      break;

    case "eval_start":
      await output.onEvalStart(msg.round, msg.judgeCount);
      break;

    case "eval_judge_verdict":
      await output.onEvalJudgeVerdict(msg.verdict, msg.round);
      break;

    case "eval_complete":
      await output.onEvalComplete(msg.passed, msg.round, msg.refinementPrompt);
      break;

    case "info":
      await output.info(msg.message);
      break;

    case "warn":
      await output.warn(msg.message);
      break;

    case "success":
      await output.success(msg.label, msg.detail);
      break;

    case "command_result":
      // Route command results as complete text. The worker pre-formats
      // the result, so we just display it.
      if (msg.isError) {
        await output.onError(msg.text);
      } else {
        await output.onAssistantTextComplete(msg.text);
        await output.onTurnComplete("end_turn");
      }
      break;

    // ready, busy, idle are handled by the worker manager — not forwarded
    case "ready":
    case "busy":
    case "idle":
      break;

    default: {
      // Exhaustive check — TypeScript will error if a message type is missed
      const _exhaustive: never = msg;
      log(`Unhandled worker message type: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Telegram Transport Setup
// ═══════════════════════════════════════════════════════════════════════════════

/** Gateway commands that are handled locally, not forwarded to the worker. */
const GATEWAY_LOCAL_COMMANDS = new Set(["/reload", "/status", "/quit", "/exit"]);

/**
 * Worker commands that are forwarded as `GatewayCommand` messages to the
 * worker for execution. These require access to the worker's in-memory state
 * (messages, config, tools, context). The worker handles them and responds
 * with a `command_result` message.
 */
const WORKER_COMMANDS = new Set([
  "/clear",
  "/compact",
  "/tokens",
  "/help",
  "/history",
  "/model",
  "/smallmodel",
  "/undo",
  "/retry",
  "/agents",
  "/save",
  "/sessions",
  "/resume",
  "/delete-session",
  "/cache",
  "/mcp",
  "/memory",
  "/skills",
  "/debug",
]);

/**
 * Check if a message text is a slash command (starts with `/`).
 * Returns the base command name (e.g., "/model" from "/model claude-sonnet-4-20250514").
 */
function parseCommandName(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed.split(/\s+/)[0].toLowerCase();
}

/**
 * Check if a command should be forwarded to the worker.
 * All `/` commands that aren't gateway-local are forwarded to the worker.
 */
function isWorkerCommand(commandName: string): boolean {
  return WORKER_COMMANDS.has(commandName);
}

/**
 * Set up the Telegram transport and register it with the bridge.
 *
 * Creates a TelegramIOPort, validates the bot token, starts polling,
 * and wires inbound messages through the bridge to the worker. Worker
 * responses are routed back to Telegram via the output port.
 *
 * @returns The bot username on success
 * @throws If the bot token is invalid or missing
 */
async function setupTelegramTransport(
  bridge: TransportBridge,
  workerManager: AgentWorkerManager,
): Promise<string> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set.\n" +
        "Get one from @BotFather on Telegram:\n" +
        '  1. Open Telegram → search @BotFather → /newbot\n' +
        "  2. Copy the token\n" +
        '  3. Add it to ~/.claude/settings.json under env:\n' +
        '     "TELEGRAM_BOT_TOKEN": "<your-token>"',
    );
  }

  const allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS
    ? process.env.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
        .map((id) => parseInt(id.trim(), 10))
        .filter(Number.isFinite)
    : [];

  const parseMode =
    (process.env.TELEGRAM_PARSE_MODE as TelegramPortConfig["parseMode"]) ?? "Markdown";
  const verboseTools = process.env.TELEGRAM_VERBOSE_TOOLS === "true";

  const telegramConfig: TelegramPortConfig = {
    botToken,
    allowedChatIds: allowedChatIds.length > 0 ? allowedChatIds : undefined,
    parseMode,
    verboseTools,
  };

  const port = new TelegramIOPort(telegramConfig);

  // Validate token before starting polling
  let botUsername: string;
  try {
    botUsername = await port.validateToken();
  } catch (error) {
    throw new Error(
      `Failed to validate Telegram bot token: ${error instanceof Error ? error.message : error}`,
    );
  }

  // Register the transport handler — routes worker messages to Telegram output
  bridge.registerTransport("telegram", {
    name: `telegram:@${botUsername}`,
    handleWorkerMessage: async (msg: WorkerMessage) => {
      await routeWorkerMessageToOutput(msg, port.output);
    },
  });

  // Start polling and route inbound messages to the worker via the bridge
  (async () => {
    try {
      for await (const userMsg of port.input.messages()) {
        const text = userMsg.text;
        const chatId = String(userMsg.metadata?.chatId ?? "unknown");
        const commandName = parseCommandName(text);

        // Handle gateway-local commands
        if (commandName === "/reload") {
          log(`[telegram] /reload command from chat ${chatId}`);
          port.output.setChatId(userMsg.metadata?.chatId as number);

          // Guard: skip if already reloading or spawning to prevent
          // infinite reload loops (e.g., stale /reload replayed from Telegram)
          if (workerManager.getStatus().reloading) {
            log(`[telegram] /reload skipped — already reloading`);
            await port.output.info("⏳ Reload already in progress — skipping.");
            continue;
          }

          await port.output.info("♻️ Reloading agent worker…");
          try {
            await workerManager.reload();
            await port.output.success("Worker reloaded", "Agent worker restarted successfully.");
          } catch (err) {
            await port.output.onError(
              `Reload failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          continue;
        }

        if (commandName === "/status") {
          log(`[telegram] /status command from chat ${chatId}`);
          port.output.setChatId(userMsg.metadata?.chatId as number);
          const status = workerManager.getStatus();
          const statusText = [
            "📊 *Gateway Status*",
            `• Worker PID: ${status.pid ?? "not running"}`,
            `• Ready: ${status.ready ? "✅" : "❌"}`,
            `• Busy: ${status.busy ? "🔄" : "💤"}`,
            `• Queue: ${status.queueLength} message(s)`,
            `• Uptime: ${formatUptime(process.uptime())}`,
          ].join("\n");
          await port.output.onAssistantTextComplete(statusText);
          await port.output.onTurnComplete("end_turn");
          continue;
        }

        // Forward worker commands via the command IPC channel
        if (commandName && isWorkerCommand(commandName)) {
          log(`[telegram] Command ${commandName} from chat ${chatId}`);
          const metadata: UserMessageMetadata = {
            chatId,
            transport: "telegram" as TransportSource,
            ...(userMsg.metadata ?? {}),
          };
          bridge.routeCommandToWorker(text, metadata);
          continue;
        }

        // Regular message — route through bridge to worker
        const metadata: UserMessageMetadata = {
          chatId,
          transport: "telegram" as TransportSource,
          ...(userMsg.metadata ?? {}),
        };

        bridge.routeToWorker(text, metadata, userMsg.images);
      }
    } catch (err) {
      log(`[telegram] Polling loop error: ${err instanceof Error ? err.message : err}`);
    }
  })();

  log(`Telegram transport active: @${botUsername}`);
  if (allowedChatIds.length > 0) {
    log(`  Allowed chats: ${allowedChatIds.join(", ")}`);
  } else {
    log("  ⚠ No TELEGRAM_ALLOWED_CHAT_IDS set — accepting ALL chats");
  }

  return botUsername;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Teams Transport Setup
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set up the Teams transport and register it with the bridge.
 *
 * Creates a TeamsIOPort, validates Azure Bot credentials, starts the
 * webhook HTTP server, and wires messages through the bridge.
 *
 * @returns A description string on success
 * @throws If credentials are invalid or missing
 */
async function setupTeamsTransport(
  bridge: TransportBridge,
  workerManager: AgentWorkerManager,
): Promise<string> {
  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;

  if (!appId || !appPassword) {
    throw new Error(
      "TEAMS_APP_ID and/or TEAMS_APP_PASSWORD are not set.\n" +
        "To set up a Teams bot:\n" +
        "  1. Go to https://portal.azure.com → Create resource → Azure Bot\n" +
        "  2. Copy the Microsoft App ID and create a client secret\n" +
        "  3. Set TEAMS_APP_ID and TEAMS_APP_PASSWORD in env or .env.gateway",
    );
  }

  const teamsPort = parseInt(process.env.TEAMS_PORT ?? "3978", 10);
  const hostname = process.env.TEAMS_HOSTNAME ?? "0.0.0.0";
  const verboseTools = process.env.TEAMS_VERBOSE_TOOLS === "true";
  const skipAuth = process.env.TEAMS_SKIP_AUTH === "true";
  const allowedTenantIds = process.env.TEAMS_ALLOWED_TENANTS
    ? process.env.TEAMS_ALLOWED_TENANTS.split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const teamsConfig: TeamsPortConfig = {
    appId,
    appPassword,
    port: teamsPort,
    hostname,
    verboseTools,
    skipAuth,
    allowedTenantIds: allowedTenantIds.length > 0 ? allowedTenantIds : undefined,
  };

  const port = new TeamsIOPort(teamsConfig);

  // Validate credentials
  try {
    await port.validateCredentials();
  } catch (error) {
    throw new Error(
      `Failed to validate Teams credentials: ${error instanceof Error ? error.message : error}`,
    );
  }

  // Register the transport handler — routes worker messages to Teams output
  bridge.registerTransport("teams", {
    name: "teams:bot",
    handleWorkerMessage: async (msg: WorkerMessage) => {
      await routeWorkerMessageToOutput(msg, port.output);
    },
  });

  // Start the webhook server and route inbound messages to the worker
  (async () => {
    try {
      for await (const userMsg of port.input.messages()) {
        const text = userMsg.text;
        const conversationId =
          (userMsg.metadata?.conversationId as string)?.slice(0, 20) ?? "unknown";
        const commandName = parseCommandName(text);

        // Handle gateway-local commands
        if (commandName === "/reload") {
          log(`[teams] /reload command from conversation ${conversationId}`);
          if (
            userMsg.metadata?.serviceUrl &&
            userMsg.metadata?.conversationId &&
            userMsg.metadata?.activityId
          ) {
            port.output.setContext(
              userMsg.metadata.serviceUrl as string,
              userMsg.metadata.conversationId as string,
              userMsg.metadata.activityId as string,
            );
          }

          // Guard: skip if already reloading
          if (workerManager.getStatus().reloading) {
            log(`[teams] /reload skipped — already reloading`);
            await port.output.info("⏳ Reload already in progress — skipping.");
            continue;
          }

          await port.output.info("♻️ Reloading agent worker…");
          try {
            await workerManager.reload();
            await port.output.success("Worker reloaded", "Agent worker restarted successfully.");
          } catch (err) {
            await port.output.onError(
              `Reload failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          continue;
        }

        if (commandName === "/status") {
          log(`[teams] /status command from conversation ${conversationId}`);
          if (
            userMsg.metadata?.serviceUrl &&
            userMsg.metadata?.conversationId &&
            userMsg.metadata?.activityId
          ) {
            port.output.setContext(
              userMsg.metadata.serviceUrl as string,
              userMsg.metadata.conversationId as string,
              userMsg.metadata.activityId as string,
            );
          }
          const status = workerManager.getStatus();
          const statusText = [
            "📊 **Gateway Status**",
            `• Worker PID: ${status.pid ?? "not running"}`,
            `• Ready: ${status.ready ? "✅" : "❌"}`,
            `• Busy: ${status.busy ? "🔄" : "💤"}`,
            `• Queue: ${status.queueLength} message(s)`,
            `• Uptime: ${formatUptime(process.uptime())}`,
          ].join("\n");
          await port.output.onAssistantTextComplete(statusText);
          await port.output.onTurnComplete("end_turn");
          continue;
        }

        // Forward worker commands via the command IPC channel
        if (commandName && isWorkerCommand(commandName)) {
          log(`[teams] Command ${commandName} from conversation ${conversationId}`);
          const metadata: UserMessageMetadata = {
            chatId: (userMsg.metadata?.conversationId as string) ?? "unknown",
            transport: "teams" as TransportSource,
            ...(userMsg.metadata ?? {}),
          };
          bridge.routeCommandToWorker(text, metadata);
          continue;
        }

        // Regular message — route through bridge to worker
        const metadata: UserMessageMetadata = {
          chatId: (userMsg.metadata?.conversationId as string) ?? "unknown",
          transport: "teams" as TransportSource,
          ...(userMsg.metadata ?? {}),
        };

        bridge.routeToWorker(text, metadata, userMsg.images);
      }
    } catch (err) {
      log(`[teams] Webhook loop error: ${err instanceof Error ? err.message : err}`);
    }
  })();

  const endpoint = `http://${hostname}:${teamsPort}/api/messages`;
  log(`Teams transport active: ${endpoint}`);
  if (skipAuth) {
    log("  ⚠ Auth DISABLED (TEAMS_SKIP_AUTH=true) — for local dev only!");
  }

  return endpoint;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Terminal Transport Setup
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set up the terminal (stdin/stdout) transport and register it with the bridge.
 *
 * Creates a TerminalIOPort for interactive console usage. This is the
 * default transport when no Telegram or Teams flags are set — it gives
 * you the same REPL experience as `npm start`, but with the agent
 * running in a hot-reloadable child process.
 *
 * Gateway commands (`/reload`, `/status`) are intercepted locally;
 * everything else is forwarded to the worker.
 */
async function setupTerminalTransport(
  bridge: TransportBridge,
  workerManager: AgentWorkerManager,
): Promise<void> {
  const port = new TerminalIOPort();

  // Register the transport handler — routes worker messages to terminal output
  bridge.registerTransport("terminal", {
    name: "terminal:console",
    handleWorkerMessage: async (msg: WorkerMessage) => {
      await routeWorkerMessageToOutput(msg, port.output);
    },
  });

  // Start reading stdin and route messages to the worker via the bridge
  (async () => {
    try {
      for await (const userMsg of port.input.messages()) {
        const text = userMsg.text;
        const commandName = parseCommandName(text);

        // Handle gateway-local commands
        if (commandName === "/reload") {
          log("Terminal /reload command");
          port.output.info("♻️ Reloading agent worker…");
          try {
            await workerManager.reload();
            port.output.success("Worker reloaded", "Agent worker restarted successfully.");
          } catch (err) {
            await port.output.onError(
              `Reload failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          continue;
        }

        if (commandName === "/status") {
          const status = workerManager.getStatus();
          const statusLines = [
            "📊 Gateway Status",
            `  Worker PID: ${status.pid ?? "not running"}`,
            `  Ready: ${status.ready ? "✅" : "❌"}`,
            `  Busy: ${status.busy ? "🔄" : "💤"}`,
            `  Queue: ${status.queueLength} message(s)`,
            `  Uptime: ${formatUptime(process.uptime())}`,
          ];
          port.output.info(statusLines.join("\n"));
          continue;
        }

        if (commandName === "/quit" || commandName === "/exit") {
          log("Terminal /quit — shutting down gateway");
          process.kill(process.pid, "SIGINT");
          break;
        }

        // Forward worker commands via the command IPC channel
        if (commandName && isWorkerCommand(commandName)) {
          log(`Terminal command: ${commandName}`);
          bridge.routeCommandToWorker(text, {
            chatId: "terminal",
            transport: "terminal",
          });
          continue;
        }

        // Regular message — route through bridge to worker
        bridge.routeToWorker(text, {
          chatId: "terminal",
          transport: "terminal",
        });
      }
    } catch (err) {
      log(`[terminal] Input loop error: ${err instanceof Error ? err.message : err}`);
    }
  })();

  log("Terminal transport active: stdin/stdout");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Timestamped log prefix for gateway messages. */
function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
  console.log(`[gateway ${ts}] ${message}`);
}

/** Format seconds into a human-readable uptime string. */
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Parse CLI args to determine which transports to enable and other settings.
 *
 * - `--telegram`      → force enable Telegram
 * - `--teams`         → force enable Teams
 * - `--terminal`      → force enable terminal/stdin transport
 * - `--auto-reload`   → watch dist/ for changes and hot-reload the worker
 * - (no flags)        → auto-detect: Telegram/Teams from env vars, terminal as fallback
 */
function parseTransportArgs(): {
  telegram: boolean;
  teams: boolean;
  terminal: boolean;
  autoReload: boolean;
} {
  const args = process.argv.slice(2);
  const hasTelegramFlag = args.includes("--telegram");
  const hasTeamsFlag = args.includes("--teams");
  const hasTerminalFlag = args.includes("--terminal");
  const hasAutoReload = args.includes("--auto-reload");

  // If explicit transport flags are given, use them
  if (hasTelegramFlag || hasTeamsFlag || hasTerminalFlag) {
    return {
      telegram: hasTelegramFlag,
      teams: hasTeamsFlag,
      terminal: hasTerminalFlag,
      autoReload: hasAutoReload,
    };
  }

  // Auto-detect based on env vars
  const telegram = !!process.env.TELEGRAM_BOT_TOKEN;
  const teams = !!(process.env.TEAMS_APP_ID && process.env.TEAMS_APP_PASSWORD);

  // If no remote transports are configured, default to terminal
  const terminal = !telegram && !teams;

  return { telegram, teams, terminal, autoReload: hasAutoReload };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const startTime = Date.now();

  // ── Determine which transports to enable ──
  const transports = parseTransportArgs();

  // ── Create worker manager ──
  const workerManager = new AgentWorkerManager();

  // ── Create transport bridge ──
  const bridge = new TransportBridge(workerManager);

  // ── Set up transports ──
  const activeTransports: string[] = [];

  let telegramInfo: string | undefined;
  let teamsInfo: string | undefined;

  if (transports.telegram) {
    try {
      telegramInfo = await setupTelegramTransport(bridge, workerManager);
      activeTransports.push(`telegram:@${telegramInfo}`);
    } catch (err) {
      console.error(`❌ Telegram setup failed:\n   ${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }
  }

  if (transports.teams) {
    try {
      teamsInfo = await setupTeamsTransport(bridge, workerManager);
      activeTransports.push(`teams:${teamsInfo}`);
    } catch (err) {
      console.error(`❌ Teams setup failed:\n   ${err instanceof Error ? err.message : err}\n`);
      process.exit(1);
    }
  }

  if (transports.terminal) {
    await setupTerminalTransport(bridge, workerManager);
    activeTransports.push("terminal:console");
  }

  // ── Spawn the agent worker ──
  // Retry up to 3 times with increasing delay — on Windows, the previous
  // process tree may still be cleaning up when we attempt to spawn.
  const MAX_SPAWN_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_SPAWN_RETRIES; attempt++) {
    try {
      await workerManager.spawn();
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_SPAWN_RETRIES) {
        log(`Spawn attempt ${attempt} failed (${msg}), retrying in ${attempt}s…`);
        await new Promise<void>((r) => setTimeout(r, attempt * 1000));
      } else {
        console.error(
          `❌ Failed to spawn agent worker after ${MAX_SPAWN_RETRIES} attempts:\n   ${msg}\n`,
        );
        process.exit(1);
      }
    }
  }

  // ── Print startup banner ──
  const setupMs = Date.now() - startTime;

  // For terminal transport, print a minimal banner (no box drawing
  // because TerminalOutputPort uses the same stdout)
  if (transports.terminal && !transports.telegram && !transports.teams) {
    const status = workerManager.getStatus();
    console.log();
    console.log("🚀 Gateway started (terminal mode)");
    console.log(`   Worker PID: ${status.pid ?? "?"} | CWD: ${process.cwd()}`);
    console.log(`   All REPL commands available: /help, /status, /model, /compact, …`);
    console.log();
  } else {
    console.log();
    console.log("┌──────────────────────────────────────────────────┐");
    console.log("│              🚀 Gateway Started                   │");
    console.log("├──────────────────────────────────────────────────┤");
    for (const t of activeTransports) {
      console.log(`│  Transport: ${t.slice(0, 36).padEnd(36)}│`);
    }
    const status = workerManager.getStatus();
    console.log(`│  Worker:    PID ${String(status.pid ?? "?").padEnd(33)}│`);
    console.log(`│  CWD:       ${process.cwd().slice(0, 36).padEnd(36)}│`);
    console.log(`│  Setup:     ${String(setupMs + "ms").padEnd(36)}│`);
    console.log("├──────────────────────────────────────────────────┤");
    console.log("│  Gateway:   /reload  /status  /quit              │");
    console.log("│  Agent:     /help  /clear  /compact  /model  …   │");
    console.log("│  Press Ctrl+C to stop                            │");
    console.log("└──────────────────────────────────────────────────┘");
    console.log();
  }

  // ── Graceful shutdown state (declared early so auto-reload can reference it) ──
  let shuttingDown = false;

  // ── Auto-reload: watch dist/ for worker changes and hot-reload ──
  let distWatcher: FSWatcher | null = null;
  let tscChild: import("child_process").ChildProcess | null = null;

  if (transports.autoReload) {
    // Watch the compiled worker file for changes.
    // When tsc --watch recompiles, the worker .js files change on disk,
    // and we automatically hot-reload the worker process (no restart
    // of the gateway itself needed).
    const watchTarget = resolve(dirname(WORKER_PATH));
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let reloading = false;

    distWatcher = fsWatch(watchTarget, { persistent: false }, (_event, filename) => {
      // Only reload when .js files change (not .map or .d.ts)
      if (!filename || !filename.endsWith(".js")) return;

      // Debounce: tsc often writes multiple files in quick succession
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        reloadTimer = null;
        if (reloading || shuttingDown) return;
        reloading = true;
        log(`[auto-reload] Detected change in ${filename}, reloading worker…`);
        try {
          await workerManager.reload();
          log("[auto-reload] Worker reloaded successfully ✓");
        } catch (err) {
          log(`[auto-reload] Reload failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          reloading = false;
        }
      }, 500);
    });

    log("[auto-reload] Watching dist/gateway/ for worker changes");

    // Also spawn tsc --watch as a child process for compilation.
    // The gateway stays alive; only the worker restarts on changes.
    const projectRoot = resolve(__dirname, "..", "..");
    const isWindows = process.platform === "win32";
    tscChild = cpSpawn(
      isWindows ? "npx.cmd" : "npx",
      ["tsc", "--watch", "--preserveWatchOutput"],
      {
        cwd: projectRoot,
        stdio: ["ignore", "inherit", "inherit"],
        shell: false,
      },
    );
    tscChild.on("exit", (code) => {
      if (!shuttingDown) {
        log(`[auto-reload] tsc --watch exited (code ${code})`);
      }
    });
    tscChild.unref(); // Don't keep gateway alive just for tsc
    log("[auto-reload] Started tsc --watch for compilation");
  }

  // ── Graceful shutdown ──

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down…");

    // Stop file watcher and tsc if running
    if (distWatcher) {
      distWatcher.close();
      distWatcher = null;
    }
    if (tscChild) {
      tscChild.kill();
      tscChild = null;
    }

    // Shut down worker first
    await workerManager.shutdown();

    // Then shut down transports (they may have in-flight messages)
    log("Gateway stopped.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Keep the process alive ──
  // The gateway stays alive via the transport polling loops and the
  // child process IPC channel. No explicit keepalive needed.
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
