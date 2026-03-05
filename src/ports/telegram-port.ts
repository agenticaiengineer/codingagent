/**
 * Telegram I/O Port — connects the agentic core to a Telegram bot.
 *
 * Uses the Telegram Bot API via long-polling (`getUpdates`). No external
 * dependencies beyond the built-in `fetch` (Node 18+).
 *
 * Architecture:
 * ```
 *   Telegram ←→ TelegramIOPort
 *                  ├── TelegramInputPort  (polls getUpdates, yields UserMessages)
 *                  └── TelegramOutputPort (batches text, sends via sendMessage)
 *                          ↓
 *                    SessionRunner (transport-agnostic core)
 *                          ↓
 *                    agenticLoop (yields LoopYield events)
 * ```
 *
 * SOLID alignment:
 * - **S**: TelegramInputPort handles polling only; TelegramOutputPort handles
 *   sending only; TelegramApiClient handles HTTP only.
 * - **O**: Adding webhook support = new InputPort implementation, no changes
 *   to output port or session runner.
 * - **L**: Substitutable anywhere an IOPort is expected — the session runner
 *   never knows it's talking to Telegram.
 * - **I**: InputPort and OutputPort are separate — a logging-only consumer
 *   only needs OutputPort.
 * - **D**: Session runner depends on IOPort, not on this concrete module.
 *
 * Key design decisions:
 *
 * 1. **Sequential processing**: Messages are processed one at a time.
 *    The agentic loop mutates messages[] and ToolContext in place, so
 *    concurrent access would corrupt state.
 *
 * 2. **Long-polling over webhooks**: Simpler to deploy (no public URL,
 *    no TLS cert). For production, implement TelegramWebhookInputPort.
 *
 * 3. **Markdown fallback**: Telegram's parser is strict — unbalanced
 *    formatting characters cause 400 errors. Output port catches these
 *    and retries as plain text.
 *
 * 4. **Chat ID routing**: The TelegramIOPort uses a callback pattern
 *    (not monkey-patching) to set the output chat ID when input arrives.
 *
 * @module telegram-port
 */

import type { InputPort, IOPort, UserMessage, ImageAttachment } from "./io-port.js";
import { BaseOutputPort } from "./io-port.js";
import type { ToolResult } from "../core/types.js";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findTool } from "../tools/index.js";

// ── Configuration ────────────────────────────────────────────────────────────

export interface TelegramPortConfig {
  /** Bot token from @BotFather. */
  botToken: string;

  /**
   * Whitelist of allowed chat IDs. If empty/undefined, all chats are allowed.
   * **Security**: Always set this in production to prevent unauthorized access.
   */
  allowedChatIds?: number[];

  /** Timeout for long-polling `getUpdates` call in seconds (default: 30). */
  longPollTimeoutSec?: number;

  /**
   * Maximum message length before splitting. Telegram's limit is 4096
   * characters; we default to 4000 to leave a safety margin.
   */
  maxMessageLength?: number;

  /** Parse mode for sent messages (default: "Markdown"). */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";

  /**
   * Whether to send tool use/result details. When false (default), only
   * the final assistant response is sent. When true, tool invocations
   * and results are sent as separate messages for transparency.
   */
  verboseTools?: boolean;
}

// ── Telegram API types (minimal subset) ──────────────────────────────────────

interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    voice?: TelegramVoice;
    audio?: TelegramVoice;
    photo?: TelegramPhotoSize[];
    caption?: string;
    date: number;
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
}

// ── Telegram API Client ──────────────────────────────────────────────────────

/**
 * Thin wrapper around the Telegram Bot API HTTP endpoints.
 * Extracted as a single-responsibility class so both input and output
 * can share it without duplicating HTTP logic.
 */
class TelegramApiClient {
  private readonly baseUrl: string;
  private readonly botToken: string;

  constructor(botToken: string) {
    if (!botToken || typeof botToken !== "string") {
      throw new Error("TelegramApiClient: botToken must be a non-empty string");
    }
    this.botToken = botToken;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async getUpdates(offset: number, timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const url = `${this.baseUrl}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=["message"]`;
    const res = await fetch(url, { signal });
    const data = (await res.json()) as TelegramApiResponse<TelegramUpdate[]>;
    if (!data.ok) throw new Error(`Telegram getUpdates error: ${data.description}`);
    return data.result;
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode?: string
  ): Promise<{ message_id: number }> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    };
    if (parseMode) body.parse_mode = parseMode;

    const res = await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as TelegramApiResponse<{ message_id: number }>;

    if (!data.ok) {
      if (data.error_code === 400 && data.description?.includes("parse")) {
        throw new MarkdownParseError(data.description);
      }
      throw new Error(`Telegram sendMessage error [${data.error_code}]: ${data.description}`);
    }
    return data.result;
  }

  async sendChatAction(chatId: number, action: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
      });
    } catch {
      // Best-effort — typing indicator is non-critical
    }
  }

  async getMe(): Promise<{ id: number; username?: string; first_name: string }> {
    const res = await fetch(`${this.baseUrl}/getMe`);
    const data = (await res.json()) as TelegramApiResponse<{ id: number; username?: string; first_name: string }>;
    if (!data.ok) throw new Error(`Telegram getMe error: ${data.description}`);
    return data.result;
  }

  async getFile(fileId: string): Promise<{ file_id: string; file_path?: string }> {
    const res = await fetch(`${this.baseUrl}/getFile?file_id=${fileId}`);
    const data = (await res.json()) as TelegramApiResponse<{ file_id: string; file_path?: string }>;
    if (!data.ok) throw new Error(`Telegram getFile error: ${data.description}`);
    return data.result;
  }

  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram downloadFile error: ${res.status}`);
    return res.arrayBuffer();
  }
}

class MarkdownParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownParseError";
  }
}

// ── Telegram Input Port ──────────────────────────────────────────────────────

/**
 * Polls the Telegram `getUpdates` endpoint and yields user messages.
 *
 * The `onMessage` callback fires for each yielded message — this is how
 * TelegramIOPort routes the chat ID to the output port without the input
 * port needing to know about the output port (avoiding SRP violation).
 */
export class TelegramInputPort implements InputPort {
  private readonly api: TelegramApiClient;
  private readonly allowedChatIds: Set<number>;
  private readonly longPollTimeout: number;
  private readonly onMessage?: (msg: UserMessage) => void;
  private offset = 0;
  private closed = false;
  private pollAbort = new AbortController();
  /** Startup timestamp — messages older than this are skipped on first poll. */
  private readonly startupTime = Math.floor(Date.now() / 1000);

  constructor(
    api: TelegramApiClient,
    config: TelegramPortConfig,
    onMessage?: (msg: UserMessage) => void
  ) {
    this.api = api;
    this.allowedChatIds = new Set(config.allowedChatIds ?? []);
    this.longPollTimeout = config.longPollTimeoutSec ?? 30;
    this.onMessage = onMessage;
  }

  async *messages(): AsyncIterable<UserMessage> {
    while (!this.closed) {
      let updates: TelegramUpdate[];
      try {
        // Use the instance abort controller so close() can interrupt
        // the in-flight long-poll immediately.
        updates = await this.api.getUpdates(
          this.offset,
          this.longPollTimeout,
          this.pollAbort.signal
        );
      } catch (error) {
        if (this.closed) break;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("abort")) break; // AbortError from close()
        if (msg.includes("401") || msg.includes("Unauthorized")) {
          console.error("[telegram] ❌ Bot token is invalid (401 Unauthorized). Stopping.");
          break;
        }
        console.error("[telegram] Polling error (retrying in 5s):", msg);
        await sleep(5000);
        continue;
      }

      for (const update of updates) {
        // Always advance offset to ACK the update, even if we skip it
        this.offset = update.update_id + 1;

        if (!update.message) continue;

        // Skip stale messages from before this process started.
        // This prevents replaying old commands (especially /reload)
        // that would otherwise cause infinite restart loops.
        const messageAge = this.startupTime - (update.message.date ?? 0);
        if (messageAge > 30) {
          console.log(
            `[telegram] Skipping stale message (${messageAge}s old) from chat ${update.message.chat.id}: "${(update.message.text ?? "").slice(0, 40)}"`
          );
          continue;
        }

        const chatId = update.message.chat.id;

        // Authorization check
        if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(chatId)) {
          await this.api.sendMessage(chatId, "⛔ Unauthorized. This bot is restricted to specific chats.").catch(() => {});
          continue;
        }

        let messageText = update.message.text;

        // Handle voice/audio messages — download and transcribe with Whisper
        const voiceFile = update.message.voice ?? update.message.audio;
        if (voiceFile && !messageText) {
          try {
            await this.api.sendChatAction(chatId, "typing");
            messageText = await this.transcribeVoice(voiceFile.file_id);
            // Notify user what was transcribed
            await this.api.sendMessage(chatId, `🎤 _${messageText}_`, "Markdown").catch(() => {});
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("[telegram] Voice transcription failed:", errMsg);
            await this.api.sendMessage(chatId, `❌ Voice transcription failed: ${errMsg}`).catch(() => {});
            continue;
          }
        }

        // Handle photo messages — download and forward to Claude for vision analysis
        let images: ImageAttachment[] | undefined;
        const photoSizes = update.message.photo;
        if (photoSizes && photoSizes.length > 0) {
          try {
            await this.api.sendChatAction(chatId, "typing");
            // Take the last element — largest resolution
            const largest = photoSizes[photoSizes.length - 1];
            const fileInfo = await this.api.getFile(largest.file_id);
            if (!fileInfo.file_path) throw new Error("No file_path returned from Telegram");

            const imageData = await this.api.downloadFile(fileInfo.file_path);
            const base64 = Buffer.from(imageData).toString("base64");

            // Detect MIME type from file extension
            const ext = (fileInfo.file_path.split(".").pop() ?? "jpg").toLowerCase();
            const mimeMap: Record<string, string> = {
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              png: "image/png",
              gif: "image/gif",
              webp: "image/webp",
              bmp: "image/bmp",
              tiff: "image/tiff",
              tif: "image/tiff",
            };
            const mediaType = mimeMap[ext] ?? "image/jpeg";

            images = [{ data: base64, mediaType }];

            // Use caption as text, or a default prompt
            if (!messageText) {
              messageText = update.message.caption || "What's in this image?";
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("[telegram] Photo download failed:", errMsg);
            await this.api.sendMessage(chatId, `❌ Photo processing failed: ${errMsg}`).catch(() => {});
            continue;
          }
        }

        if (!messageText) continue;

        const userMsg: UserMessage = {
          text: messageText,
          images,
          metadata: {
            chatId,
            messageId: update.message.message_id,
            fromUserId: update.message.from?.id,
            fromUsername: update.message.from?.username,
            chatType: update.message.chat.type,
          },
        };

        // Notify the IOPort so it can route the chat ID to the output port
        this.onMessage?.(userMsg);

        yield userMsg;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pollAbort.abort();
  }

  /**
   * Download a voice/audio file from Telegram and transcribe it using
   * the built-in Transcribe tool (local Whisper ONNX — no Python, no ffmpeg).
   */
  private async transcribeVoice(fileId: string): Promise<string> {
    // 1. Get file path from Telegram
    const fileInfo = await this.api.getFile(fileId);
    if (!fileInfo.file_path) throw new Error("No file_path returned from Telegram");

    // 2. Download the audio file
    const audioData = await this.api.downloadFile(fileInfo.file_path);

    // 3. Save to temp file (Telegram voice = .oga, audio = .mp3/.m4a etc.)
    const tempDir = join(tmpdir(), "codingagent-voice");
    mkdirSync(tempDir, { recursive: true });
    const ext = fileInfo.file_path.split(".").pop() ?? "oga";
    const tempFile = join(tempDir, `voice_${Date.now()}.${ext}`);
    writeFileSync(tempFile, Buffer.from(audioData));

    try {
      // 4. Use the built-in Transcribe tool (pure WASM, no external deps)
      const transcribeTool = findTool("Transcribe");
      if (!transcribeTool) {
        throw new Error("Transcribe tool not found — cannot transcribe voice messages");
      }

      const result = await transcribeTool.execute(
        { file_path: tempFile, model: "base" },
        {
          cwd: tempDir,
          abortController: new AbortController(),
          agentId: "telegram-voice",
          depth: 0,
          readFileState: new Map() as any,
        }
      );

      if (result.is_error) {
        throw new Error(result.content);
      }

      // 5. Extract just the transcript text (skip metadata header)
      const lines = result.content.split("\n");
      const emptyIdx = lines.indexOf("");
      if (emptyIdx >= 0 && emptyIdx + 1 < lines.length) {
        // Text starts after the first blank line (after metadata header)
        const textLines = lines.slice(emptyIdx + 1);
        // Stop before "=== Timestamps ===" if present
        const tsIdx = textLines.findIndex(l => l.startsWith("=== Timestamps"));
        const transcript = (tsIdx >= 0 ? textLines.slice(0, tsIdx) : textLines)
          .join(" ")
          .trim();
        if (transcript && transcript !== "(No speech detected)") {
          return transcript;
        }
      }

      throw new Error("No speech detected in voice message");
    } finally {
      // 6. Clean up temp file
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }
}

// ── Telegram Output Port ─────────────────────────────────────────────────────

/**
 * Sends output to a specific Telegram chat. Batches streaming assistant
 * text and sends it as a single message when the turn completes — Telegram
 * is message-oriented, not stream-oriented.
 *
 * Tool use/result events are optionally sent as concise notification
 * messages so the user can follow progress (controlled by `verboseTools`).
 */
export class TelegramOutputPort extends BaseOutputPort {
  private readonly api: TelegramApiClient;
  private readonly maxLen: number;
  private readonly parseMode: string | undefined;
  private readonly verboseTools: boolean;

  /** The chat ID to send messages to. Set per user message. */
  private chatId: number | null = null;

  /** Buffer for streaming assistant text (flushed on turn complete). */
  private textBuffer = "";

  /** Periodic "typing" indicator interval — Telegram typing expires ~5s. */
  private typingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(api: TelegramApiClient, config: TelegramPortConfig) {
    super();
    this.api = api;
    this.maxLen = config.maxMessageLength ?? 4000;
    this.parseMode = config.parseMode ?? "Markdown";
    this.verboseTools = config.verboseTools ?? false;
  }

  /** Set the target chat ID. Called by TelegramIOPort per message. */
  setChatId(chatId: number): void {
    this.chatId = chatId;
  }

  // ── OutputPort implementation ──

  onAssistantText(text: string): void {
    this.textBuffer += text;
  }

  async onAssistantTextComplete(_fullText: string): Promise<void> {
    // Flushed in onTurnComplete
  }

  async onToolUse(toolName: string, _input: Record<string, unknown>): Promise<void> {
    if (this.verboseTools) {
      await this.send(`🔧 \`${toolName}\``);
    }
  }

  async onToolResult(toolName: string, result: ToolResult, durationMs?: number): Promise<void> {
    if (!this.verboseTools) return;
    const icon = result.is_error ? "❌" : "✅";
    const duration = durationMs ? ` (${Math.round(durationMs)}ms)` : "";
    const preview = truncateContent(result.content, 200);
    await this.send(`${icon} \`${toolName}\`${duration}\n\`\`\`\n${preview}\n\`\`\``);
  }

  async onTurnComplete(_stopReason: string): Promise<void> {
    this.stopTypingIndicator();
    if (this.textBuffer.trim()) {
      await this.send(this.textBuffer);
      this.textBuffer = "";
    }
  }

  async onError(error: string): Promise<void> {
    this.stopTypingIndicator();
    await this.send(`❌ Error:\n\`\`\`\n${truncateContent(error, 500)}\n\`\`\``);
  }

  async onApiCallStart(): Promise<void> {
    this.startTypingIndicator();
  }

  async onApiCallEnd(_durationMs: number, _usage?: { inputTokens: number; outputTokens: number }): Promise<void> {
    // Keep typing active — tools may run next
  }

  async info(message: string): Promise<void> {
    await this.send(`ℹ️ ${message}`);
  }

  async warn(message: string): Promise<void> {
    await this.send(`⚠️ ${message}`);
  }

  async success(label: string, detail?: string): Promise<void> {
    const msg = detail ? `✅ ${label} — ${detail}` : `✅ ${label}`;
    await this.send(msg);
  }

  async close(): Promise<void> {
    this.stopTypingIndicator();
  }

  // ── Private helpers ──

  private startTypingIndicator(): void {
    if (this.typingInterval || !this.chatId) return;
    this.api.sendChatAction(this.chatId, "typing");
    const chatId = this.chatId;
    this.typingInterval = setInterval(() => {
      this.api.sendChatAction(chatId, "typing");
    }, 4000);
  }

  private stopTypingIndicator(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.chatId || !text.trim()) return;

    const chunks = splitMessage(text, this.maxLen);
    for (const chunk of chunks) {
      try {
        await this.api.sendMessage(this.chatId, chunk, this.parseMode);
      } catch (error) {
        if (error instanceof MarkdownParseError && this.parseMode) {
          try {
            await this.api.sendMessage(this.chatId, chunk);
          } catch (retryError) {
            console.error("[telegram] Failed to send (plain text retry):", retryError);
          }
        } else {
          console.error("[telegram] Failed to send:", error instanceof Error ? error.message : error);
        }
      }
    }
  }
}

// ── Combined Telegram Port ───────────────────────────────────────────────────

/**
 * Combined bidirectional Telegram port.
 *
 * Uses a callback pattern (not monkey-patching) to route the chat ID
 * from incoming messages to the output port. The input port fires
 * `onMessage` → TelegramIOPort calls `output.setChatId()`.
 */
export class TelegramIOPort implements IOPort {
  readonly name: string;
  readonly input: TelegramInputPort;
  readonly output: TelegramOutputPort;
  private readonly api: TelegramApiClient;
  private _name: string;

  constructor(config: TelegramPortConfig) {
    this.api = new TelegramApiClient(config.botToken);
    this._name = "telegram:bot";

    this.output = new TelegramOutputPort(this.api, config);

    // Use the callback pattern instead of monkey-patching messages().
    // When TelegramInputPort yields a message, it calls this callback
    // first — we extract the chat ID and set it on the output port.
    this.input = new TelegramInputPort(this.api, config, (msg) => {
      if (msg.metadata?.chatId) {
        this.output.setChatId(msg.metadata.chatId as number);
      }
    });

    // Satisfy the readonly interface with a getter
    this.name = this._name;
  }

  /**
   * Validate the bot token by calling `getMe`. Returns the bot's username
   * on success, throws on failure. Call before `runSession` to fail fast.
   */
  async validateToken(): Promise<string> {
    const me = await this.api.getMe();
    const username = me.username ?? me.first_name;
    this._name = `telegram:@${username}`;
    // Update the public name
    (this as { name: string }).name = this._name;
    return username;
  }

  async close(): Promise<void> {
    await this.input.close();
    await this.output.close();
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

/**
 * Split a message into chunks that fit within a maximum length.
 * Tries to split on newline boundaries for readability.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (maxLen < 1) maxLen = 4000; // guard against invalid maxLen
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
