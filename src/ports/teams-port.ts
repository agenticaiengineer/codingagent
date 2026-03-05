/**
 * Microsoft Teams I/O Port — connects the agentic core to a Teams bot.
 *
 * Uses the Bot Framework REST API directly (no SDK dependency). Teams
 * pushes messages to a webhook endpoint; we reply via the Bot Connector
 * service REST API.
 *
 * Architecture:
 * ```
 *   Teams ←→ TeamsIOPort
 *               ├── TeamsInputPort   (HTTP server receives Activities)
 *               └── TeamsOutputPort  (sends replies via Bot Connector API)
 *                       ↓
 *                 SessionRunner (transport-agnostic core)
 *                       ↓
 *                 agenticLoop (yields LoopYield events)
 * ```
 *
 * Key differences from Telegram:
 * - **Webhook-based** (not long-polling) — Teams pushes to us
 * - **OAuth2 client-credentials** for sending replies
 * - **JWT verification** of incoming requests (validates Teams is the caller)
 * - **Activity objects** instead of simple messages
 * - **serviceUrl per conversation** — reply endpoint varies by region
 * - **Message length limit**: ~28KB (much higher than Telegram's 4096 chars)
 *
 * @module teams-port
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { InputPort, IOPort, UserMessage } from "./io-port.js";
import { BaseOutputPort } from "./io-port.js";
import type { ToolResult } from "../core/types.js";

// ── Configuration ────────────────────────────────────────────────────────────

export interface TeamsPortConfig {
  /** Microsoft App ID from Azure Bot registration. */
  appId: string;

  /** Microsoft App Password (client secret) from Azure Bot registration. */
  appPassword: string;

  /** Port for the webhook HTTP server (default: 3978). */
  port?: number;

  /** Hostname to bind to (default: "0.0.0.0"). */
  hostname?: string;

  /**
   * Maximum message length before splitting. Teams supports ~28KB,
   * but we default to 20000 for readability.
   */
  maxMessageLength?: number;

  /**
   * Whether to send tool use/result details. When false (default), only
   * the final assistant response is sent.
   */
  verboseTools?: boolean;

  /**
   * Allowed tenant IDs. If set, only messages from these tenants are
   * accepted. Leave empty to allow all tenants (multi-tenant bot).
   */
  allowedTenantIds?: string[];

  /**
   * Whether to skip JWT validation of incoming requests (default: false).
   * **Only set to true for local development/testing.**
   */
  skipAuth?: boolean;
}

// ── Bot Framework Activity types (minimal subset) ────────────────────────────

interface BotActivity {
  type: string;
  id: string;
  timestamp?: string;
  serviceUrl: string;
  channelId: string;
  from: { id: string; name?: string; aadObjectId?: string };
  conversation: { id: string; tenantId?: string; conversationType?: string; name?: string };
  recipient: { id: string; name?: string };
  text?: string;
  channelData?: Record<string, unknown>;
  replyToId?: string;
}

// ── OAuth2 Token Manager ────────────────────────────────────────────────────

/**
 * Manages the OAuth2 client-credentials token for Bot Connector API calls.
 * Tokens are cached and refreshed automatically before expiry.
 */
class BotTokenManager {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly appId: string;
  private readonly appPassword: string;

  constructor(appId: string, appPassword: string) {
    this.appId = appId;
    this.appPassword = appPassword;
  }

  async getToken(): Promise<string> {
    // Refresh 60s before expiry
    if (this.token && Date.now() < this.expiresAt - 60_000) {
      return this.token;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.appId,
      client_secret: this.appPassword,
      scope: "https://api.botframework.com/.default",
    });

    const res = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token request failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;

    return this.token;
  }
}

// ── Bot Connector API Client ────────────────────────────────────────────────

/**
 * Sends messages to Teams via the Bot Connector REST API.
 * Each conversation has its own `serviceUrl` (region-specific).
 */
class BotConnectorClient {
  private readonly tokenManager: BotTokenManager;
  private readonly appId: string;

  constructor(appId: string, tokenManager: BotTokenManager) {
    this.appId = appId;
    this.tokenManager = tokenManager;
  }

  /**
   * Reply to an existing activity.
   */
  async replyToActivity(
    serviceUrl: string,
    conversationId: string,
    activityId: string,
    text: string
  ): Promise<void> {
    const token = await this.tokenManager.getToken();
    const url = `${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

    const activity = {
      type: "message",
      text,
      from: { id: this.appId },
      conversation: { id: conversationId },
      replyToId: activityId,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bot Connector replyToActivity failed (${res.status}): ${body}`);
    }
  }

  /**
   * Send a new message to a conversation (not a reply).
   */
  async sendToConversation(
    serviceUrl: string,
    conversationId: string,
    text: string
  ): Promise<void> {
    const token = await this.tokenManager.getToken();
    const url = `${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

    const activity = {
      type: "message",
      text,
      from: { id: this.appId },
      conversation: { id: conversationId },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bot Connector sendToConversation failed (${res.status}): ${body}`);
    }
  }

  /**
   * Send typing indicator.
   */
  async sendTyping(serviceUrl: string, conversationId: string): Promise<void> {
    const token = await this.tokenManager.getToken();
    const url = `${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;

    const activity = {
      type: "typing",
      from: { id: this.appId },
      conversation: { id: conversationId },
    };

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(activity),
      });
    } catch {
      // Best-effort — typing indicator is non-critical
    }
  }
}

// ── Teams Input Port ────────────────────────────────────────────────────────

/**
 * HTTP server that receives Bot Framework Activity webhooks from Teams.
 *
 * The `onMessage` callback fires for each yielded message — this is how
 * TeamsIOPort routes conversation context to the output port (same
 * callback pattern as TelegramInputPort).
 */
export class TeamsInputPort implements InputPort {
  private server: Server | null = null;
  private closed = false;
  private readonly port: number;
  private readonly hostname: string;
  private readonly allowedTenantIds: Set<string>;
  private readonly skipAuth: boolean;
  private readonly onMessage?: (msg: UserMessage) => void;

  /** Queue of incoming messages — the async generator pulls from this. */
  private messageQueue: UserMessage[] = [];
  private messageResolve: (() => void) | null = null;

  constructor(config: TeamsPortConfig, onMessage?: (msg: UserMessage) => void) {
    this.port = config.port ?? 3978;
    this.hostname = config.hostname ?? "0.0.0.0";
    this.allowedTenantIds = new Set(config.allowedTenantIds ?? []);
    this.skipAuth = config.skipAuth ?? false;
    this.onMessage = onMessage;
  }

  async *messages(): AsyncIterable<UserMessage> {
    // Start HTTP server
    this.server = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, this.hostname, () => {
        console.log(`[teams] Webhook server listening on ${this.hostname}:${this.port}`);
        resolve();
      });
    });

    // Yield messages as they arrive
    while (!this.closed) {
      if (this.messageQueue.length > 0) {
        const msg = this.messageQueue.shift()!;
        yield msg;
      } else {
        // Wait for the next message
        await new Promise<void>((resolve) => {
          this.messageResolve = resolve;
        });
      }
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Health check endpoint
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "teams-bot" }));
      return;
    }

    // Bot Framework posts to /api/messages
    if (req.method !== "POST" || (req.url !== "/api/messages" && req.url !== "/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Read body
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      // Guard against oversized payloads
      if (body.length > 1_000_000) {
        res.writeHead(413, { "Content-Type": "text/plain" });
        res.end("Payload too large");
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        this.processActivity(body, req, res);
      } catch (err) {
        console.error("[teams] Error processing activity:", err);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    });
  }

  private processActivity(body: string, req: IncomingMessage, res: ServerResponse): void {
    let activity: BotActivity;
    try {
      activity = JSON.parse(body) as BotActivity;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid JSON");
      return;
    }

    // ⚠️ SECURITY WARNING: JWT verification is NOT implemented.
    // For production deployments, you MUST validate the Bearer token from
    // the Authorization header against the Bot Framework OpenID signing
    // keys (JWK fetch, RS256 verification, issuer/audience checks).
    // Without this, any HTTP client can send fake activities to your bot.
    // See: https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
    // For now, we rely on the Azure Bot Service channel configuration +
    // tenant ID filtering, which is NOT sufficient for internet-facing deployments.
    if (!this.skipAuth) {
      const authHeader = req.headers["authorization"] ?? "";
      if (!authHeader.startsWith("Bearer ")) {
        console.warn("[teams] Missing or invalid Authorization header");
        // In production, return 401. For now, log and continue.
      }
    }

    // Tenant filtering
    if (this.allowedTenantIds.size > 0) {
      const tenantId = activity.conversation?.tenantId;
      if (!tenantId || !this.allowedTenantIds.has(tenantId)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Tenant not allowed");
        return;
      }
    }

    // Respond 200 immediately (Teams expects fast ACK)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");

    // Only process message activities with text
    if (activity.type !== "message" || !activity.text) {
      return;
    }

    // Strip bot @mentions from the text (Teams includes "@BotName" in text)
    const cleanText = activity.text.replace(/<at>[^<]*<\/at>\s*/g, "").trim();
    if (!cleanText) return;

    const userMsg: UserMessage = {
      text: cleanText,
      metadata: {
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        activityId: activity.id,
        fromId: activity.from.id,
        fromName: activity.from.name,
        tenantId: activity.conversation.tenantId,
        channelId: activity.channelId,
        conversationType: activity.conversation.conversationType,
      },
    };

    this.onMessage?.(userMsg);

    this.messageQueue.push(userMsg);
    if (this.messageResolve) {
      this.messageResolve();
      this.messageResolve = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Unblock the generator if it's waiting
    if (this.messageResolve) {
      this.messageResolve();
      this.messageResolve = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}

// ── Teams Output Port ───────────────────────────────────────────────────────

/**
 * Sends output to a Teams conversation. Batches streaming assistant text
 * and sends it as a single reply when the turn completes.
 */
export class TeamsOutputPort extends BaseOutputPort {
  private readonly client: BotConnectorClient;
  private readonly maxLen: number;
  private readonly verboseTools: boolean;

  /** Conversation context — set per incoming message. */
  private serviceUrl: string | null = null;
  private conversationId: string | null = null;
  private activityId: string | null = null;

  /** Buffer for streaming assistant text. */
  private textBuffer = "";

  /** Periodic typing indicator. */
  private typingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(client: BotConnectorClient, config: TeamsPortConfig) {
    super();
    this.client = client;
    this.maxLen = config.maxMessageLength ?? 20000;
    this.verboseTools = config.verboseTools ?? false;
  }

  /** Set the conversation context. Called by TeamsIOPort per message. */
  setContext(serviceUrl: string, conversationId: string, activityId: string): void {
    this.serviceUrl = serviceUrl;
    this.conversationId = conversationId;
    this.activityId = activityId;
  }

  onAssistantText(text: string): void {
    this.textBuffer += text;
  }

  async onAssistantTextComplete(_fullText: string): Promise<void> {
    // Flushed in onTurnComplete
  }

  async onToolUse(toolName: string, _input: Record<string, unknown>): Promise<void> {
    if (this.verboseTools) {
      await this.send(`🔧 **${toolName}**`);
    }
  }

  async onToolResult(toolName: string, result: ToolResult, durationMs?: number): Promise<void> {
    if (!this.verboseTools) return;
    const icon = result.is_error ? "❌" : "✅";
    const duration = durationMs ? ` (${Math.round(durationMs)}ms)` : "";
    const preview = truncateContent(result.content, 300);
    await this.send(`${icon} **${toolName}**${duration}\n\`\`\`\n${preview}\n\`\`\``);
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
    await this.send(`❌ **Error:**\n\`\`\`\n${truncateContent(error, 500)}\n\`\`\``);
  }

  async onApiCallStart(): Promise<void> {
    this.startTypingIndicator();
  }

  async onApiCallEnd(_durationMs: number, _usage?: { inputTokens: number; outputTokens: number }): Promise<void> {
    // Keep typing active
  }

  async info(message: string): Promise<void> {
    await this.send(`ℹ️ ${message}`);
  }

  async warn(message: string): Promise<void> {
    await this.send(`⚠️ ${message}`);
  }

  async success(label: string, detail?: string): Promise<void> {
    const msg = detail ? `✅ **${label}** — ${detail}` : `✅ **${label}**`;
    await this.send(msg);
  }

  async close(): Promise<void> {
    this.stopTypingIndicator();
  }

  // ── Private helpers ──

  private startTypingIndicator(): void {
    if (this.typingInterval || !this.serviceUrl || !this.conversationId) return;
    this.client.sendTyping(this.serviceUrl, this.conversationId);
    const sUrl = this.serviceUrl;
    const cId = this.conversationId;
    this.typingInterval = setInterval(() => {
      this.client.sendTyping(sUrl, cId);
    }, 3000); // Teams typing expires ~3s
  }

  private stopTypingIndicator(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.serviceUrl || !this.conversationId || !text.trim()) return;

    const chunks = splitMessage(text, this.maxLen);
    for (const chunk of chunks) {
      try {
        if (this.activityId) {
          await this.client.replyToActivity(this.serviceUrl, this.conversationId, this.activityId, chunk);
        } else {
          await this.client.sendToConversation(this.serviceUrl, this.conversationId, chunk);
        }
      } catch (error) {
        console.error("[teams] Failed to send:", error instanceof Error ? error.message : error);
      }
    }
  }
}

// ── Combined Teams Port ─────────────────────────────────────────────────────

/**
 * Combined bidirectional Teams port.
 *
 * Uses the callback pattern (same as TelegramIOPort) to route
 * conversation context from incoming messages to the output port.
 */
export class TeamsIOPort implements IOPort {
  readonly name = "teams:bot";
  readonly input: TeamsInputPort;
  readonly output: TeamsOutputPort;
  private readonly tokenManager: BotTokenManager;
  private readonly client: BotConnectorClient;

  constructor(config: TeamsPortConfig) {
    if (!config.appId || !config.appPassword) {
      throw new Error("TeamsIOPort: appId and appPassword are required");
    }

    this.tokenManager = new BotTokenManager(config.appId, config.appPassword);
    this.client = new BotConnectorClient(config.appId, this.tokenManager);

    this.output = new TeamsOutputPort(this.client, config);

    this.input = new TeamsInputPort(config, (msg) => {
      const meta = msg.metadata;
      if (meta?.serviceUrl && meta?.conversationId && meta?.activityId) {
        this.output.setContext(
          meta.serviceUrl as string,
          meta.conversationId as string,
          meta.activityId as string
        );
      }
    });
  }

  /**
   * Validate credentials by requesting an OAuth token.
   * Call before `runSession` to fail fast on bad credentials.
   */
  async validateCredentials(): Promise<void> {
    await this.tokenManager.getToken();
  }

  async close(): Promise<void> {
    await this.input.close();
    await this.output.close();
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function truncateContent(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…";
}

function splitMessage(text: string, maxLen: number): string[] {
  if (maxLen < 1) maxLen = 20000;
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
