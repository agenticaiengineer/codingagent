/**
 * Session Runner — the transport-agnostic core that connects an `IOPort`
 * to the `agenticLoop`. This is the "main loop" extracted from `index.ts`,
 * but decoupled from any specific I/O transport.
 *
 * It reads `UserMessage`s from `IOPort.input`, feeds them to the agentic
 * loop, and routes `LoopYield` events to `IOPort.output`.
 *
 * SOLID alignment:
 * - **S**: This module orchestrates the message ↔ loop ↔ output plumbing.
 *   It doesn't know about terminal readline, Telegram APIs, or spinners.
 * - **O**: Adding a new transport requires zero changes here — just a new
 *   `IOPort` implementation.
 * - **D**: Depends on `IOPort` (abstraction), never on concrete ports.
 *
 * @module session-runner
 */

import type { Message, ToolContext, Tool, AppConfig } from "../core/types.js";
import type { IOPort, OutputPort } from "../ports/io-port.js";
import { routeLoopEvent } from "../ports/io-port.js";
import { agenticLoop } from "../core/loop.js";
import { estimateTokens, microCompact, autoCompact, repairOrphanedToolUse } from "../core/compaction.js";

// ── Session Runner Options ───────────────────────────────────────────────────

export interface SessionRunnerOptions {
  /** The I/O port providing user input and consuming output. */
  port: IOPort;

  /** Pre-seeded messages (e.g., restored from a saved session). */
  messages?: Message[];

  /** System prompt for the agentic loop. */
  systemPrompt: string;

  /** Tool set to expose to the model. */
  tools: readonly Tool[];

  /** Tool context (cwd, abort controller, file state, etc.). */
  context: ToolContext;

  /**
   * Application config — injected rather than read from the `getConfig()`
   * singleton so the session runner has no hidden dependencies (DIP).
   */
  config: AppConfig;

  /** Override the default model. */
  model?: string;

  /** Maximum turns per user message. */
  maxTurns?: number;

  /** Enable the eval gate. */
  enableEval?: boolean;

  /**
   * Hook called after each completed turn. Use for auto-save, status
   * bar rendering, etc. Return `false` to abort the session.
   */
  onTurnEnd?: (messages: Message[], usage: TurnUsage) => Promise<boolean | void>;

  /**
   * Hook called before the user message is added to the messages array.
   * Can transform or reject the message.
   * Return `null` to skip (don't send to the loop).
   * Return a string to override the raw text.
   */
  onUserMessage?: (text: string, metadata?: Record<string, unknown>) => Promise<string | null>;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  apiDurationMs: number;
}

// ── Session Runner ───────────────────────────────────────────────────────────

/**
 * Runs a session: reads user messages from the port, processes them
 * through the agentic loop, and routes output events to the port.
 *
 * This is the transport-agnostic replacement for the `for await (const
 * line of rl)` loop in `index.ts`.
 */
export async function runSession(options: SessionRunnerOptions): Promise<void> {
  const {
    port,
    systemPrompt,
    tools,
    context,
    config,
    model,
    maxTurns,
    enableEval,
    onTurnEnd,
    onUserMessage,
  } = options;
  const messages: Message[] = options.messages?.slice() ?? [];
  const out = port.output;

  for await (const userMsg of port.input.messages()) {
    // ── Pre-process user message ──
    let text = userMsg.text;
    if (onUserMessage) {
      const result = await onUserMessage(text, userMsg.metadata);
      if (result === null) continue; // skip this message
      text = result;
    }

    // ── Add user message to history ──
    if (userMsg.images && userMsg.images.length > 0) {
      const contentBlocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } } | { type: "text"; text: string }> = [];
      for (const img of userMsg.images) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.data,
          },
        });
      }
      contentBlocks.push({ type: "text", text });
      messages.push({ role: "user", content: contentBlocks });
    } else {
      messages.push({ role: "user", content: text });
    }

    // ── Repair orphaned tool_use blocks (defensive, same as index.ts) ──
    repairOrphanedToolUse(messages);

    // ── Run the agentic loop ──
    const turnUsage: TurnUsage = { inputTokens: 0, outputTokens: 0, apiDurationMs: 0 };
    let assistantText = "";

    try {
      for await (const event of agenticLoop(
        messages,
        systemPrompt,
        tools,
        context,
        model,
        maxTurns,
        enableEval
      )) {
        // Track usage
        if (event.type === "api_call_end") {
          turnUsage.apiDurationMs += event.durationMs;
          if (event.usage) {
            turnUsage.inputTokens += event.usage.inputTokens;
            turnUsage.outputTokens += event.usage.outputTokens;
          }
        }

        // Route to output port (returns updated accumulated text)
        assistantText = await routeLoopEvent(event, out, assistantText);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await out.onError(`Agentic loop crashed: ${msg}`);
    }

    // Repair orphaned tool_use blocks. When the loop crashes or the user
    // aborts mid-turn, the assistant message with tool_use blocks may
    // already be in `messages` but the matching tool_result user message
    // was never added. Without this repair, the next API call would fail
    // with a 400 "missing tool_result" error, cascading into repeated
    // failures on every subsequent user message.
    repairOrphanedToolUse(messages);

    // ── Post-turn: micro-compact and auto-compact ──
    const totalTokens = estimateTokens(messages, systemPrompt.length);
    microCompact(messages);
    if (totalTokens > config.compactionThreshold) {
      await out.info("Context is large, auto-compacting…");
      await autoCompact(messages, systemPrompt);
    }

    if (onTurnEnd) {
      const shouldContinue = await onTurnEnd(messages, turnUsage);
      if (shouldContinue === false) break;
    }
  }
}

/**
 * Run a single prompt (one-shot mode) through an output port.
 * Equivalent to `runOnce()` in index.ts but transport-agnostic.
 */
export async function runSinglePrompt(options: {
  prompt: string;
  systemPrompt: string;
  tools: readonly Tool[];
  context: ToolContext;
  config: AppConfig;
  output: OutputPort;
  model?: string;
  maxTurns?: number;
  enableEval?: boolean;
}): Promise<{ hadError: boolean; inputTokens: number; outputTokens: number; apiDurationMs: number }> {
  const { prompt, systemPrompt, tools, context, config, output: out, model, maxTurns, enableEval } = options;
  const messages: Message[] = [{ role: "user", content: prompt }];

  const usage = { inputTokens: 0, outputTokens: 0, apiDurationMs: 0 };
  let hadError = false;
  let assistantText = "";

  try {
    for await (const event of agenticLoop(messages, systemPrompt, tools, context, model, maxTurns, enableEval)) {
      if (event.type === "api_call_end") {
        usage.apiDurationMs += event.durationMs;
        if (event.usage) {
          usage.inputTokens += event.usage.inputTokens;
          usage.outputTokens += event.usage.outputTokens;
        }
      }
      if (event.type === "error") hadError = true;

      assistantText = await routeLoopEvent(event, out, assistantText);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await out.onError(`Agentic loop crashed: ${msg}`);
    hadError = true;
  }

  // Post-run compaction for long single-prompt runs
  const totalTokens = estimateTokens(messages, systemPrompt.length);
  microCompact(messages);
  if (totalTokens > config.compactionThreshold) {
    await autoCompact(messages, systemPrompt);
  }

  return { hadError, ...usage };
}
