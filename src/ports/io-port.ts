/**
 * I/O Port abstraction — decouples the agentic core from any specific
 * transport (terminal, Telegram, Slack, REST API, WebSocket, etc.).
 *
 * SOLID alignment:
 * - **S** (Single Responsibility): Each port handles exactly one transport.
 * - **O** (Open/Closed): New transports are added by implementing the
 *   interface, not by modifying existing code.
 * - **L** (Liskov Substitution): Any `IOPort` can replace any other —
 *   the core loop doesn't care which transport provides input/output.
 * - **I** (Interface Segregation): `InputPort` and `OutputPort` are
 *   separate so read-only consumers don't depend on write methods.
 * - **D** (Dependency Inversion): The core depends on the `IOPort`
 *   abstraction, not on `process.stdin`/`process.stdout`.
 *
 * @module io-port
 */

import type { LoopYield, ToolResult } from "../core/types.js";

// ── Input Port ───────────────────────────────────────────────────────────────

/**
 * An image attached to a user message, encoded as base64.
 * Supported by Claude's vision API for image analysis.
 */
export interface ImageAttachment {
  /** Base64-encoded image data. */
  data: string;
  /** MIME type (e.g., "image/jpeg", "image/png", "image/gif", "image/webp"). */
  mediaType: string;
}

/**
 * Inbound user message. Transports parse their native format into this
 * structure before handing it to the core session runner.
 */
export interface UserMessage {
  /** The text content of the user's message. */
  text: string;
  /** Images attached to the message. */
  images?: ImageAttachment[];
  /** Opaque transport-specific metadata (e.g., Telegram chat_id, message_id). */
  metadata?: Record<string, unknown>;
}

/**
 * Reads user input from some transport.
 *
 * Implementations:
 * - `TerminalInputPort` — readline on stdin (interactive REPL)
 * - `TelegramInputPort` — messages from a Telegram bot webhook/polling
 * - Future: Slack, Discord, REST, WebSocket, etc.
 */
export interface InputPort {
  /**
   * Async iterator of user messages. The core session runner consumes
   * this in a `for await` loop. The iterator completes (returns) when
   * the session should end (user typed /quit, process signal, etc.).
   */
  messages(): AsyncIterable<UserMessage>;

  /**
   * Gracefully shut down the input source (close readline, stop polling,
   * disconnect WebSocket, etc.). Idempotent.
   */
  close(): Promise<void>;
}

// ── Output Port ──────────────────────────────────────────────────────────────

/**
 * Writes output to some transport.
 *
 * Methods map 1-to-1 with the `LoopYield` event types plus a few
 * lifecycle events. Default implementations (no-ops) are provided via
 * `BaseOutputPort` so concrete ports only override what they care about.
 */
export interface OutputPort {
  // ── Streaming text ──
  /** A chunk of assistant text (streaming). */
  onAssistantText(text: string): void | Promise<void>;
  /** Called once after all assistant_text chunks for a response are done. */
  onAssistantTextComplete(fullText: string): void | Promise<void>;

  // ── Tool lifecycle ──
  /** A tool invocation is about to begin. */
  onToolUse(toolName: string, input: Record<string, unknown>): void | Promise<void>;
  /** A tool has produced a result. */
  onToolResult(toolName: string, result: ToolResult, durationMs?: number): void | Promise<void>;

  // ── Turn lifecycle ──
  /** The model finished a turn. */
  onTurnComplete(stopReason: string): void | Promise<void>;
  /** An error occurred. */
  onError(error: string): void | Promise<void>;

  // ── API call telemetry ──
  /** An API call is starting (show spinner / typing indicator). */
  onApiCallStart(): void | Promise<void>;
  /** An API call finished (stop spinner, record telemetry). */
  onApiCallEnd(durationMs: number, usage?: { inputTokens: number; outputTokens: number }): void | Promise<void>;

  // ── Eval events ──
  onEvalStart(round: number, judgeCount: number): void | Promise<void>;
  onEvalJudgeVerdict(verdict: { judgeName: string; isComplete: boolean; reasoning: string }, round: number): void | Promise<void>;
  onEvalComplete(passed: boolean, round: number, refinementPrompt?: string): void | Promise<void>;

  // ── Structured notifications ──
  /** Informational message (e.g., "Session saved"). */
  info(message: string): void | Promise<void>;
  /** Warning message. */
  warn(message: string): void | Promise<void>;
  /** Success message. */
  success(label: string, detail?: string): void | Promise<void>;

  /**
   * Gracefully shut down the output transport. Idempotent.
   */
  close(): Promise<void>;
}

// ── Combined Port ────────────────────────────────────────────────────────────

/**
 * A bidirectional I/O port — combines input and output for transports
 * that naturally bundle both (terminal, Telegram bot, WebSocket).
 */
export interface IOPort {
  readonly input: InputPort;
  readonly output: OutputPort;
  /** Human-readable label for logging (e.g., "terminal", "telegram:@mybot"). */
  readonly name: string;
  /** Shut down both input and output. */
  close(): Promise<void>;
}

// ── Base Output Port (default no-ops) ────────────────────────────────────────

/**
 * Convenience base class. Concrete ports extend this and override only
 * the methods they care about. All methods are no-ops by default.
 */
export abstract class BaseOutputPort implements OutputPort {
  onAssistantText(_text: string): void | Promise<void> {}
  onAssistantTextComplete(_fullText: string): void | Promise<void> {}
  onToolUse(_toolName: string, _input: Record<string, unknown>): void | Promise<void> {}
  onToolResult(_toolName: string, _result: ToolResult, _durationMs?: number): void | Promise<void> {}
  onTurnComplete(_stopReason: string): void | Promise<void> {}
  onError(_error: string): void | Promise<void> {}
  onApiCallStart(): void | Promise<void> {}
  onApiCallEnd(_durationMs: number, _usage?: { inputTokens: number; outputTokens: number }): void | Promise<void> {}
  onEvalStart(_round: number, _judgeCount: number): void | Promise<void> {}
  onEvalJudgeVerdict(_verdict: { judgeName: string; isComplete: boolean; reasoning: string }, _round: number): void | Promise<void> {}
  onEvalComplete(_passed: boolean, _round: number, _refinementPrompt?: string): void | Promise<void> {}
  info(_message: string): void | Promise<void> {}
  warn(_message: string): void | Promise<void> {}
  success(_label: string, _detail?: string): void | Promise<void> {}
  async close(): Promise<void> {}
}

// ── Event Router ─────────────────────────────────────────────────────────────

/**
 * Routes `LoopYield` events to an `OutputPort`. This replaces the
 * duplicated `switch(event.type)` blocks in `main()` and `runOnce()`.
 *
 * Returns the updated accumulated assistant text so the caller can
 * thread it through subsequent calls without a mutable state bag.
 */
export async function routeLoopEvent(
  event: LoopYield,
  port: OutputPort,
  assistantText: string
): Promise<string> {
  switch (event.type) {
    case "assistant_text":
      await port.onAssistantText(event.text);
      return assistantText + event.text;

    case "tool_use":
      // If we had accumulated text before this tool_use, flush it
      if (assistantText) {
        await port.onAssistantTextComplete(assistantText);
      }
      await port.onToolUse(event.toolName, event.input);
      return "";

    case "tool_result":
      await port.onToolResult(event.toolName, event.result, event.durationMs);
      return assistantText;

    case "turn_complete":
      if (assistantText) {
        await port.onAssistantTextComplete(assistantText);
      }
      await port.onTurnComplete(event.stopReason);
      return "";

    case "error":
      await port.onError(event.error);
      return assistantText;

    case "api_call_start":
      await port.onApiCallStart();
      return assistantText;

    case "api_call_end":
      await port.onApiCallEnd(event.durationMs, event.usage);
      return assistantText;

    case "eval_start":
      await port.onEvalStart(event.round, event.judgeCount);
      return assistantText;

    case "eval_judge_verdict":
      await port.onEvalJudgeVerdict(event.verdict, event.round);
      return assistantText;

    case "eval_complete":
      await port.onEvalComplete(event.passed, event.round, event.refinementPrompt);
      return assistantText;

    default: {
      const _exhaustive: never = event;
      console.warn(`[routeLoopEvent] Unhandled event type: ${(_exhaustive as { type: string }).type}`);
      return assistantText;
    }
  }
}

// ── Multi-Output Port ────────────────────────────────────────────────────────

/**
 * Broadcasts output events to multiple `OutputPort` instances.
 *
 * Use cases:
 * - Terminal + file logger
 * - Terminal + Telegram mirror
 * - Any fan-out scenario
 *
 * Implements the Composite pattern — a MultiOutputPort IS an OutputPort,
 * so it can be used anywhere a single OutputPort is expected.
 */
export class MultiOutputPort extends BaseOutputPort {
  private readonly ports: OutputPort[];

  constructor(...ports: OutputPort[]) {
    super();
    this.ports = ports;
  }

  /**
   * Broadcast a callback to all ports using `Promise.allSettled` so that
   * a failure in one port never breaks the others.
   *
   * Must catch synchronous throws from `fn(port)` — OutputPort methods
   * may return `void` (not Promise), so a throw during `.map()` would
   * abort the entire broadcast before reaching `Promise.allSettled`.
   */
  private async broadcast(method: string, fn: (p: OutputPort) => void | Promise<void>): Promise<void> {
    const promises = this.ports.map((p) => {
      try {
        const result = fn(p);
        return result instanceof Promise ? result : Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    });
    const results = await Promise.allSettled(promises);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        console.error(`[MultiOutputPort] Port ${i} failed on ${method}:`, r.reason);
      }
    }
  }

  /** Add a port at runtime (e.g., after a Telegram bot connects). */
  addPort(port: OutputPort): void {
    this.ports.push(port);
  }

  /** Remove a port at runtime. */
  removePort(port: OutputPort): boolean {
    const idx = this.ports.indexOf(port);
    if (idx >= 0) {
      this.ports.splice(idx, 1);
      return true;
    }
    return false;
  }

  async onAssistantText(text: string): Promise<void> {
    await this.broadcast("onAssistantText", (p) => p.onAssistantText(text));
  }

  async onAssistantTextComplete(fullText: string): Promise<void> {
    await this.broadcast("onAssistantTextComplete", (p) => p.onAssistantTextComplete(fullText));
  }

  async onToolUse(toolName: string, input: Record<string, unknown>): Promise<void> {
    await this.broadcast("onToolUse", (p) => p.onToolUse(toolName, input));
  }

  async onToolResult(toolName: string, result: ToolResult, durationMs?: number): Promise<void> {
    await this.broadcast("onToolResult", (p) => p.onToolResult(toolName, result, durationMs));
  }

  async onTurnComplete(stopReason: string): Promise<void> {
    await this.broadcast("onTurnComplete", (p) => p.onTurnComplete(stopReason));
  }

  async onError(error: string): Promise<void> {
    await this.broadcast("onError", (p) => p.onError(error));
  }

  async onApiCallStart(): Promise<void> {
    await this.broadcast("onApiCallStart", (p) => p.onApiCallStart());
  }

  async onApiCallEnd(durationMs: number, usage?: { inputTokens: number; outputTokens: number }): Promise<void> {
    await this.broadcast("onApiCallEnd", (p) => p.onApiCallEnd(durationMs, usage));
  }

  async onEvalStart(round: number, judgeCount: number): Promise<void> {
    await this.broadcast("onEvalStart", (p) => p.onEvalStart(round, judgeCount));
  }

  async onEvalJudgeVerdict(verdict: { judgeName: string; isComplete: boolean; reasoning: string }, round: number): Promise<void> {
    await this.broadcast("onEvalJudgeVerdict", (p) => p.onEvalJudgeVerdict(verdict, round));
  }

  async onEvalComplete(passed: boolean, round: number, refinementPrompt?: string): Promise<void> {
    await this.broadcast("onEvalComplete", (p) => p.onEvalComplete(passed, round, refinementPrompt));
  }

  async info(message: string): Promise<void> {
    await this.broadcast("info", (p) => p.info(message));
  }

  async warn(message: string): Promise<void> {
    await this.broadcast("warn", (p) => p.warn(message));
  }

  async success(label: string, detail?: string): Promise<void> {
    await this.broadcast("success", (p) => p.success(label, detail));
  }

  async close(): Promise<void> {
    await this.broadcast("close", (p) => p.close());
  }
}
