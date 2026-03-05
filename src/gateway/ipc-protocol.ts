/**
 * IPC Protocol Types — JSON message protocol between the Gateway (host
 * process) and Agent Worker (child process), communicated over the
 * Node.js `child_process.fork()` IPC channel.
 *
 * Architecture:
 * ```
 *   ┌──────────┐   fork() IPC channel   ┌──────────────┐
 *   │ Gateway  │ ◄─────────────────────► │ Agent Worker │
 *   │ (host)   │   JSON messages         │ (child)      │
 *   └──────────┘                         └──────────────┘
 * ```
 *
 * All messages use a discriminated union on the `type` field. Each
 * message carries an optional `requestId` so the gateway can correlate
 * worker responses back to the originating request.
 *
 * @module ipc-protocol
 */

import type { EvalJudgeVerdictInfo, StopReason, ToolResult } from "../core/types.js";
import type { ImageAttachment } from "../ports/io-port.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Gateway → Worker Messages
// ═══════════════════════════════════════════════════════════════════════════════

/** Transport that originally produced the user message. */
export type TransportSource = "telegram" | "teams" | "terminal" | (string & {});

/**
 * Metadata attached to an inbound user message. Lets the worker know
 * which chat / conversation the message belongs to and which transport
 * it arrived from so responses can be routed back correctly.
 */
export interface UserMessageMetadata {
  /** Unique identifier for the conversation / chat session. */
  chatId: string;
  /** The transport that delivered this message. */
  transport: TransportSource;
  /** Arbitrary transport-specific fields (e.g., Telegram `message_id`). */
  [key: string]: unknown;
}

/**
 * Forward a user message to the agent for processing.
 *
 * The gateway receives messages from one or more transports (Telegram,
 * Teams, terminal, etc.), wraps them in this envelope, and sends them
 * to the worker over IPC.
 */
export interface GatewayUserMessage {
  type: "user_message";
  /** Optional correlation ID — echoed on all worker responses. */
  requestId?: string;
  /** The text content of the user's message. */
  text: string;
  /** Routing and origin metadata. */
  metadata: UserMessageMetadata;
  /** Images attached to the message. */
  images?: ImageAttachment[];
}

/**
 * Gracefully shut down the worker process.
 *
 * The worker should finish any in-progress work (or abort it), clean up
 * resources, and exit with code 0.
 */
export interface GatewayShutdown {
  type: "shutdown";
  /** Optional correlation ID. */
  requestId?: string;
}

/**
 * Abort current processing immediately (analogous to Ctrl+C).
 *
 * The worker should cancel any in-flight API calls and tool executions,
 * then transition to the `idle` state.
 */
export interface GatewayAbort {
  type: "abort";
  /** Optional correlation ID. */
  requestId?: string;
}

/**
 * Forward a REPL slash command to the worker for execution.
 *
 * Commands like `/clear`, `/compact`, `/model`, `/tokens`, etc. require
 * access to the worker's in-memory state (messages, config, tools).
 * The gateway detects the `/` prefix and sends a `command` message
 * instead of a `user_message`. The worker executes the command and
 * responds with a `command_result` message.
 */
export interface GatewayCommand {
  type: "command";
  /** Optional correlation ID — echoed on the worker's response. */
  requestId?: string;
  /** The full command string, e.g. "/model claude-sonnet-4-20250514" or "/clear". */
  command: string;
  /** Routing and origin metadata. */
  metadata: UserMessageMetadata;
}

/** Discriminated union of all messages the Gateway can send to the Worker. */
export type GatewayMessage =
  | GatewayUserMessage
  | GatewayCommand
  | GatewayShutdown
  | GatewayAbort;

// ═══════════════════════════════════════════════════════════════════════════════
// Worker → Gateway Messages
// ═══════════════════════════════════════════════════════════════════════════════

// ── Streaming text ──────────────────────────────────────────────────────────

/**
 * A chunk of streamed assistant text.
 *
 * The gateway should buffer and/or forward these chunks to the
 * originating transport (e.g., progressive message edits in Telegram,
 * SSE events to a web client).
 */
export interface WorkerAssistantText {
  type: "assistant_text";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** The text chunk. */
  text: string;
}

/**
 * The complete assistant text after all streaming chunks have been sent.
 *
 * Transports that don't support streaming can wait for this single
 * message instead of accumulating `assistant_text` chunks.
 */
export interface WorkerAssistantTextComplete {
  type: "assistant_text_complete";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** The full assembled response text. */
  text: string;
}

// ── Tool lifecycle ──────────────────────────────────────────────────────────

/**
 * A tool invocation is starting.
 *
 * The gateway can use this to show tool activity indicators in the UI.
 */
export interface WorkerToolUse {
  type: "tool_use";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Name of the tool being invoked. */
  toolName: string;
  /** The input arguments passed to the tool. */
  input: Record<string, unknown>;
}

/**
 * A tool invocation has completed and produced a result.
 */
export interface WorkerToolResult {
  type: "tool_result";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Name of the tool that produced this result. */
  toolName: string;
  /** The tool's output. */
  result: ToolResult;
  /** Wall-clock duration of the tool execution in milliseconds. */
  durationMs?: number;
}

// ── Turn lifecycle ──────────────────────────────────────────────────────────

/**
 * The model finished a turn (one request/response cycle).
 *
 * A user message may trigger multiple turns if the model decides to
 * invoke tools. The `stopReason` indicates why the model stopped.
 */
export interface WorkerTurnComplete {
  type: "turn_complete";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Why the model stopped generating. */
  stopReason: StopReason;
}

/**
 * An error occurred during processing.
 *
 * This may be an API error, a tool execution failure, or an internal
 * worker error. The worker remains alive unless the error is fatal.
 */
export interface WorkerError {
  type: "error";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Human-readable error description. */
  error: string;
  /** Whether the error is fatal and the worker will exit. */
  fatal?: boolean;
}

// ── API call telemetry ──────────────────────────────────────────────────────

/**
 * An API call to the model provider is starting.
 *
 * The gateway can use this to show typing indicators or spinners in
 * the originating transport.
 */
export interface WorkerApiCallStart {
  type: "api_call_start";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
}

/**
 * An API call to the model provider has completed.
 *
 * Carries timing and token usage data for telemetry / cost tracking.
 */
export interface WorkerApiCallEnd {
  type: "api_call_end";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Wall-clock duration of the API call in milliseconds. */
  durationMs: number;
  /** Token usage stats from the API response. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ── Eval events ─────────────────────────────────────────────────────────────

/**
 * An eval cycle is starting.
 *
 * Evals run one or more judge models to assess whether the agent's
 * output meets quality criteria.
 */
export interface WorkerEvalStart {
  type: "eval_start";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** The current eval round (1-based). */
  round: number;
  /** Number of judges that will evaluate the output. */
  judgeCount: number;
}

/**
 * A single eval judge has rendered its verdict.
 */
export interface WorkerEvalJudgeVerdict {
  type: "eval_judge_verdict";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** The judge's verdict details. */
  verdict: EvalJudgeVerdictInfo;
  /** The eval round this verdict belongs to. */
  round: number;
}

/**
 * An eval cycle has completed.
 */
export interface WorkerEvalComplete {
  type: "eval_complete";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Whether the eval passed (all judges satisfied). */
  passed: boolean;
  /** The eval round that completed. */
  round: number;
  /** If the eval failed, a prompt to refine the agent's output. */
  refinementPrompt?: string;
}

// ── Structured notifications ────────────────────────────────────────────────

/** Informational notification (e.g., "Session saved", "Context compacted"). */
export interface WorkerInfo {
  type: "info";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** The notification message. */
  message: string;
}

/** Warning notification. */
export interface WorkerWarn {
  type: "warn";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** The warning message. */
  message: string;
}

/** Success notification (e.g., "File written", "Tests passed"). */
export interface WorkerSuccess {
  type: "success";
  /** Optional correlation ID linking this to the originating request. */
  requestId?: string;
  /** Short label for the success event. */
  label: string;
  /** Optional detail text. */
  detail?: string;
}

/**
 * Result of a `/command` executed by the worker.
 *
 * The gateway receives this after sending a `GatewayCommand` and routes
 * the result text back to the originating transport. This avoids the
 * gateway needing to understand each command's semantics — the worker
 * formats the result and the gateway just forwards it.
 */
export interface WorkerCommandResult {
  type: "command_result";
  /** Correlation ID linking this to the originating GatewayCommand. */
  requestId?: string;
  /** Pre-formatted result text to display. */
  text: string;
  /** Whether the command encountered an error. */
  isError?: boolean;
}

// ── Worker state ────────────────────────────────────────────────────────────

/**
 * The worker has finished initialization and is ready to receive messages.
 *
 * The gateway MUST wait for this message before sending `user_message`
 * events — messages sent before `ready` may be dropped.
 */
export interface WorkerReady {
  type: "ready";
  /** Optional correlation ID. */
  requestId?: string;
}

/**
 * The worker is currently processing a message.
 *
 * Sent when the worker begins handling a `user_message`. The gateway
 * should not send additional `user_message` events until it receives
 * a corresponding `idle` message (single-flight processing).
 */
export interface WorkerBusy {
  type: "busy";
  /** Optional correlation ID of the request being processed. */
  requestId?: string;
}

/**
 * The worker has finished processing and is ready for the next message.
 *
 * Sent after a `user_message` has been fully handled (all turns
 * complete, final text flushed). The gateway may now send the next
 * `user_message`.
 */
export interface WorkerIdle {
  type: "idle";
  /** Optional correlation ID of the request that just completed. */
  requestId?: string;
}

/** Discriminated union of all messages the Worker can send to the Gateway. */
export type WorkerMessage =
  | WorkerAssistantText
  | WorkerAssistantTextComplete
  | WorkerToolUse
  | WorkerToolResult
  | WorkerTurnComplete
  | WorkerError
  | WorkerApiCallStart
  | WorkerApiCallEnd
  | WorkerEvalStart
  | WorkerEvalJudgeVerdict
  | WorkerEvalComplete
  | WorkerInfo
  | WorkerWarn
  | WorkerSuccess
  | WorkerCommandResult
  | WorkerReady
  | WorkerBusy
  | WorkerIdle;

// ═══════════════════════════════════════════════════════════════════════════════
// Aggregate types & utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Any message that can be sent over the IPC channel, in either direction. */
export type IpcMessage = GatewayMessage | WorkerMessage;

/** Extract the `type` string literal from a message union. */
export type GatewayMessageType = GatewayMessage["type"];
export type WorkerMessageType = WorkerMessage["type"];
export type IpcMessageType = IpcMessage["type"];

/**
 * Type guard: returns `true` if the value looks like a valid IPC message
 * (has a string `type` field). Does NOT validate payload shape — use
 * individual type guards or a schema validator for that.
 */
export function isIpcMessage(value: unknown): value is IpcMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as Record<string, unknown>).type === "string"
  );
}

/** All valid gateway → worker message type strings, for runtime validation. */
export const GATEWAY_MESSAGE_TYPES: readonly GatewayMessageType[] = [
  "user_message",
  "command",
  "shutdown",
  "abort",
] as const;

/** All valid worker → gateway message type strings, for runtime validation. */
export const WORKER_MESSAGE_TYPES: readonly WorkerMessageType[] = [
  "assistant_text",
  "assistant_text_complete",
  "tool_use",
  "tool_result",
  "turn_complete",
  "error",
  "api_call_start",
  "api_call_end",
  "eval_start",
  "eval_judge_verdict",
  "eval_complete",
  "info",
  "warn",
  "success",
  "command_result",
  "ready",
  "busy",
  "idle",
] as const;

/**
 * Type guard: narrows an unknown value to a `GatewayMessage`.
 *
 * Checks that the value is an object with a `type` field matching one
 * of the known gateway message types.
 */
export function isGatewayMessage(value: unknown): value is GatewayMessage {
  return (
    isIpcMessage(value) &&
    (GATEWAY_MESSAGE_TYPES as readonly string[]).includes(
      (value as { type: string }).type,
    )
  );
}

/**
 * Type guard: narrows an unknown value to a `WorkerMessage`.
 *
 * Checks that the value is an object with a `type` field matching one
 * of the known worker message types.
 */
export function isWorkerMessage(value: unknown): value is WorkerMessage {
  return (
    isIpcMessage(value) &&
    (WORKER_MESSAGE_TYPES as readonly string[]).includes(
      (value as { type: string }).type,
    )
  );
}
