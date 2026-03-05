/**
 * Terminal I/O port — wraps the existing terminal stdin/stdout/readline
 * infrastructure behind the `IOPort` interface.
 *
 * This is a **mechanical lift** of the current terminal coupling into the
 * port abstraction. The existing `OutputManager`, `Spinner`,
 * `InlineHintManager`, and `HintAwareInputStream` remain unchanged — this
 * port delegates to them. No behaviour changes, just a new front door.
 *
 * SOLID:
 * - **S**: TerminalInputPort handles input only; TerminalOutputPort handles output only.
 * - **L**: Both are substitutable via the InputPort/OutputPort interfaces.
 * - **I**: Input and output are separate — consumers don't depend on methods they don't use.
 * - **D**: The session runner depends on IOPort, not on this concrete class.
 *
 * @module terminal-port
 */

import { createInterface, type Interface as ReadlineInterface } from "readline";
import type { InputPort, IOPort, UserMessage } from "./io-port.js";
import { BaseOutputPort } from "./io-port.js";
import type { ToolResult } from "../core/types.js";
import {
  Spinner,
  InlineHintManager,
  formatToolUse,
  formatToolResult,
  formatError,
  commandCompleter,
  cyan,
  green,
  yellow,
  bold,
  output,
} from "../ui/ui.js";
import { renderMarkdown, isMarkdownEnabled } from "../ui/markdown.js";

// ── Terminal Input Port ──────────────────────────────────────────────────────

/**
 * Input port that reads from terminal stdin via Node's readline module.
 *
 * The `onReadlineCreated` callback allows the owning `TerminalIOPort` to
 * register SIGINT handlers and other lifecycle hooks on the readline
 * interface — without exposing the readline instance as a public method
 * (which would leak the terminal abstraction through the InputPort interface).
 */
export class TerminalInputPort implements InputPort {
  private rl: ReadlineInterface | null = null;
  private hintManager: InlineHintManager | null = null;
  private closed = false;

  constructor(
    private readonly prompt: string = `\n${cyan(">")} `,
    private readonly onReadlineCreated?: (rl: ReadlineInterface, hintManager: InlineHintManager) => void
  ) {}

  async *messages(): AsyncIterable<UserMessage> {
    this.hintManager = new InlineHintManager();
    this.rl = createInterface({
      input: this.hintManager.createInputStream(),
      output: process.stdout,
      prompt: this.prompt,
      completer: commandCompleter,
    });
    this.hintManager.attachReadline(this.rl);

    // Notify owner (TerminalIOPort) that readline is ready — this is how
    // the combined port wires the OutputManager and SIGINT handlers without
    // exposing readline through the InputPort interface.
    this.onReadlineCreated?.(this.rl, this.hintManager);

    this.rl.prompt();

    // Buffer for multi-line input (lines ending with \)
    let buffer = "";

    for await (const line of this.rl) {
      if (this.closed) break;

      const trimmed = (line as string).trimEnd();

      // Multi-line continuation
      if (trimmed.endsWith("\\")) {
        buffer += trimmed.slice(0, -1) + "\n";
        continue;
      }

      const fullLine = buffer + trimmed;
      buffer = "";

      if (!fullLine.trim()) {
        this.rl.prompt();
        continue;
      }

      yield { text: fullLine };

      // Re-prompt after the message is processed
      if (!this.closed && this.rl) {
        this.rl.prompt();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    output.detachReadline();
    this.hintManager?.detach();
    this.rl?.close();
    this.rl = null;
    this.hintManager = null;
  }
}

// ── Terminal Output Port ─────────────────────────────────────────────────────

/**
 * Output port that writes to the terminal via stdout.
 *
 * Delegates structured output (info/warn/success) to the `OutputManager`
 * singleton which handles readline-safe prompt clearing. Streaming text
 * uses `output.write()` for consistency.
 *
 * **Markdown rendering:**
 * When markdown rendering is enabled (TTY, colors on), streamed text chunks
 * are buffered silently while a spinner shows "Composing…". When the full
 * response arrives in `onAssistantTextComplete`, the complete text is
 * rendered as styled Markdown (headings, bold, code blocks with syntax
 * highlighting, tables, lists, etc.) in a single pass. This avoids partial
 * rendering artifacts from streaming incomplete Markdown chunks.
 *
 * When markdown is disabled (NO_COLOR, non-TTY, piped output), text is
 * streamed raw as before for compatibility with scripts and redirections.
 */
export class TerminalOutputPort extends BaseOutputPort {
  private spinner = new Spinner("Thinking…");
  private spinnerActive = false;

  /**
   * Whether we're currently buffering streamed text for markdown rendering.
   * When true, `onAssistantText` appends to `streamBuffer` instead of
   * writing to stdout, and `onAssistantTextComplete` renders the full
   * markdown.
   */
  private markdownMode = isMarkdownEnabled();

  /**
   * Number of raw characters written to stdout during streaming.
   * Used to erase the raw text before re-rendering as markdown.
   */
  private streamedCharCount = 0;

  /**
   * Whether we've started streaming for the current response.
   * Reset on each `onAssistantTextComplete` call.
   */
  private isStreaming = false;

  private stopSpinner(): void {
    if (this.spinnerActive) {
      this.spinner.stop();
      this.spinnerActive = false;
    }
  }

  onAssistantText(text: string): void {
    this.stopSpinner();

    if (this.markdownMode) {
      // In markdown mode: stream raw text so the user sees progress,
      // then we'll replace it with rendered markdown on completion.
      if (!this.isStreaming) {
        this.isStreaming = true;
        this.streamedCharCount = 0;
      }
      output.write(text);
      this.streamedCharCount += text.length;
    } else {
      // No markdown — stream raw text directly
      output.write(text);
    }
  }

  onAssistantTextComplete(fullText: string): void {
    if (!this.markdownMode || !this.isStreaming) return;

    // Erase the raw streamed text by moving cursor back and clearing.
    // Strategy: count the lines the raw text occupied, move up that many
    // lines, clear to end of screen, then print the rendered markdown.
    if (this.streamedCharCount > 0) {
      const cols = process.stdout.columns || 80;
      // Count actual newlines in the raw text + wrapped lines
      const rawLines = fullText.split("\n");
      let totalRows = 0;
      for (const line of rawLines) {
        // Each line takes at least 1 row; long lines wrap
        totalRows += Math.max(1, Math.ceil((line.length || 1) / cols));
      }

      // Move cursor up to the start of the streamed text and clear
      if (totalRows > 0) {
        // Move to start of line, then up N-1 rows (we're already on the last row)
        const upCount = totalRows - 1;
        let eraseSeq = "\r"; // carriage return to column 0
        if (upCount > 0) {
          eraseSeq += `\x1b[${upCount}A`; // move up
        }
        eraseSeq += "\x1b[0J"; // clear from cursor to end of screen
        process.stdout.write(eraseSeq);
      }
    }

    // Render the full markdown and output it
    const rendered = renderMarkdown(fullText);
    output.write(rendered);

    // Reset streaming state
    this.isStreaming = false;
    this.streamedCharCount = 0;
  }

  onToolUse(toolName: string, input: Record<string, unknown>): void {
    this.stopSpinner();
    output.log(`\n${formatToolUse(toolName, input)}`);
    this.spinner.update(`Running ${toolName}…`);
    this.spinner.start();
    this.spinnerActive = true;
  }

  onToolResult(toolName: string, result: ToolResult, durationMs?: number): void {
    this.stopSpinner();
    output.log(formatToolResult(toolName, result.content, durationMs, result.is_error));
  }

  onTurnComplete(_stopReason: string): void {
    this.stopSpinner();
    output.log(""); // newline after assistant response
  }

  onError(error: string): void {
    this.stopSpinner();
    output.log(`\n${formatError(error)}`);
  }

  onApiCallStart(): void {
    this.spinner.start();
    this.spinnerActive = true;
  }

  onApiCallEnd(_durationMs: number, _usage?: { inputTokens: number; outputTokens: number }): void {
    this.stopSpinner();
  }

  onEvalStart(round: number, judgeCount: number): void {
    this.stopSpinner();
    output.log(`\n${bold(`🔍 Eval round ${round}`)} — ${judgeCount} judges evaluating…`);
    this.spinner.update("Evaluating…");
    this.spinner.start();
    this.spinnerActive = true;
  }

  onEvalJudgeVerdict(verdict: { judgeName: string; isComplete: boolean; reasoning: string }, _round: number): void {
    this.stopSpinner();
    const icon = verdict.isComplete ? green("✓") : yellow("✗");
    output.log(`  ${icon} ${bold(verdict.judgeName)}: ${verdict.reasoning}`);
  }

  onEvalComplete(passed: boolean, round: number, _refinementPrompt?: string): void {
    this.stopSpinner();
    if (passed) {
      output.log(`\n${green("✅")} ${bold("Eval passed")} — majority of judges approved (round ${round})`);
    } else {
      output.log(`\n${yellow("🔄")} ${bold("Eval failed")} — refining (round ${round})…`);
    }
  }

  info(message: string): void {
    output.info(message);
  }

  warn(message: string): void {
    output.warn(message);
  }

  success(label: string, detail?: string): void {
    output.success(label, detail);
  }

  async close(): Promise<void> {
    this.stopSpinner();
  }
}

// ── Combined Terminal Port ───────────────────────────────────────────────────

/**
 * Combined bidirectional terminal port.
 *
 * Wires the input and output together with the `OutputManager` — when
 * readline is created by the input port, it's registered with the
 * OutputManager so that `output.log()` calls are readline-safe.
 */
export class TerminalIOPort implements IOPort {
  readonly name = "terminal";
  readonly input: TerminalInputPort;
  readonly output: TerminalOutputPort;

  constructor(prompt?: string) {
    this.output = new TerminalOutputPort();
    // The callback fires when TerminalInputPort creates its readline inside
    // messages(). This is the bridge between input and the OutputManager
    // without exposing readline through the InputPort interface.
    this.input = new TerminalInputPort(prompt, (rl, hintManager) => {
      output.setReadline(rl, hintManager);
    });
  }

  async close(): Promise<void> {
    await this.input.close();
    await this.output.close();
  }
}
