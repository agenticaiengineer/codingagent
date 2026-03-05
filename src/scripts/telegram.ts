#!/usr/bin/env node
/**
 * Telegram bot entry point.
 *
 * Starts the coding agent as a Telegram bot that receives messages from
 * Telegram chats and sends results back. Runs as a long-polling process.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 *
 * 1. Create a bot via @BotFather on Telegram → copy the bot token.
 * 2. Message your bot once so a chat exists (or add it to a group).
 * 3. Find your chat ID: `curl https://api.telegram.org/bot<TOKEN>/getUpdates`
 *    → look for `"chat":{"id":123456789}` in the response.
 * 4. Set environment variables and run:
 *
 *    TELEGRAM_BOT_TOKEN=<token> \
 *    TELEGRAM_ALLOWED_CHAT_IDS=<your-chat-id> \
 *    ANTHROPIC_API_KEY=sk-ant-... \
 *    npm run telegram
 *
 * ── Environment Variables ──────────────────────────────────────────────────
 *
 *   TELEGRAM_BOT_TOKEN         (required) Bot token from @BotFather
 *   ANTHROPIC_API_KEY          (required) Anthropic API key
 *   TELEGRAM_ALLOWED_CHAT_IDS  Comma-separated chat IDs to whitelist.
 *                              If unset, the bot accepts messages from ANYONE.
 *   TELEGRAM_VERBOSE_TOOLS     Set to "true" to send tool use/result details.
 *                              Defaults to false (only final response is sent).
 *   TELEGRAM_PARSE_MODE        "Markdown" (default) | "MarkdownV2" | "HTML"
 *
 * ── Security ───────────────────────────────────────────────────────────────
 *
 * ⚠️  This bot has FULL ACCESS to the filesystem, shell commands, and the
 * internet via the same tools the terminal agent uses. **Always** set
 * TELEGRAM_ALLOWED_CHAT_IDS to restrict access to your own chat.
 *
 * @module telegram
 */

import { loadConfig } from "../config/config.js";
import { createContext } from "../core/context.js";
import { getAllTools, registerMcpTools } from "../tools/index.js";
import { spawnAgent } from "../core/agent.js";
import { loadMcpServers, getMcpTools, getMcpInstructions, shutdownMcpServers } from "../core/mcp-client.js";
import { loadProjectMemory, loadSkills, getSkillDescriptions } from "../config/skills.js";
import { TelegramIOPort, type TelegramPortConfig } from "../ports/telegram-port.js";
import { runSession } from "../session/session-runner.js";
import type { Tool, ToolContext } from "../core/types.js";

// ── System Prompt ────────────────────────────────────────────────────────────

/**
 * Build the system prompt dynamically from the registered tools array.
 * This avoids hardcoding tool names and ensures the prompt stays in sync
 * when tools are added/removed.
 */
function getSystemPrompt(cwd: string, tools: readonly Tool[]): string {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`).join("\n");

  let prompt = `You are a coding assistant with access to tools for reading, writing, and editing files, searching codebases, and executing commands.

You have access to the following tools:
${toolList}

Important rules:
- Always read a file before editing or overwriting it
- Use Glob and Grep to explore the codebase before making changes
- Be concise in your responses — you are running as a Telegram bot
- All tool calls are auto-approved — no permission prompts
- Keep responses well-formatted for mobile reading
- Telegram Markdown is limited: only *bold*, _italic_, \`code\`, \`\`\`pre\`\`\` work
- Avoid very long responses — Telegram truncates at 4096 characters per message

Current working directory: ${cwd}
Platform: ${process.platform}
Date: ${new Date().toISOString()}
`;

  const mcpTools = getMcpTools();
  if (mcpTools.length > 0) {
    const mcpToolLines = mcpTools.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`);
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // loadConfig() calls loadAllEnv() which populates process.env from
  // .env.telegram, .env, settings.json, and secrets.json.
  const config = loadConfig();

  // ── Validate required env vars ──
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error(
      "❌ TELEGRAM_BOT_TOKEN is not set.\n\n" +
      "Get one from @BotFather on Telegram:\n" +
      "  1. Open Telegram → search @BotFather → /newbot\n" +
      "  2. Copy the token\n" +
      "  3. Add it to ~/.claude/settings.json under env:\n" +
      '     "TELEGRAM_BOT_TOKEN": "<your-token>"\n'
    );
    process.exit(1);
  }

  if (!config.apiKey) {
    console.error(
      "❌ ANTHROPIC_API_KEY is not set.\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...\n"
    );
    process.exit(1);
  }

  // ── Parse optional config ──
  const allowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS
    ? process.env.TELEGRAM_ALLOWED_CHAT_IDS.split(",")
        .map((id) => parseInt(id.trim(), 10))
        .filter(Number.isFinite)
    : [];

  const parseMode = (process.env.TELEGRAM_PARSE_MODE as TelegramPortConfig["parseMode"]) ?? "Markdown";
  const verboseTools = process.env.TELEGRAM_VERBOSE_TOOLS === "true";

  // ── Set up tool context ──
  const context: ToolContext = createContext();
  context.spawnAgent = (prompt, options) => spawnAgent(prompt, options, context);

  // ── Load MCP servers ──
  await loadMcpServers(context.cwd);
  const mcpTools = getMcpTools();
  if (mcpTools.length > 0) registerMcpTools(mcpTools);

  // ── Load skills ──
  loadSkills(context.cwd);

  // ── Resolve tools ──
  const tools = getAllTools();

  // ── Create Telegram port ──
  const telegramConfig: TelegramPortConfig = {
    botToken,
    allowedChatIds: allowedChatIds.length > 0 ? allowedChatIds : undefined,
    parseMode,
    verboseTools,
  };
  const port = new TelegramIOPort(telegramConfig);

  // ── Validate token before starting the loop ──
  let botUsername: string;
  try {
    botUsername = await port.validateToken();
  } catch (error) {
    console.error(
      "❌ Failed to validate Telegram bot token:\n" +
      `   ${error instanceof Error ? error.message : error}\n\n` +
      "Check that TELEGRAM_BOT_TOKEN is correct and not revoked."
    );
    process.exit(1);
  }

  // ── Print startup banner ──
  console.log("┌─────────────────────────────────────────────┐");
  console.log(`│  🤖 Telegram bot: @${botUsername.padEnd(25)}│`);
  console.log("├─────────────────────────────────────────────┤");
  console.log(`│  Model:     ${config.model.padEnd(32)}│`);
  console.log(`│  CWD:       ${context.cwd.slice(0, 32).padEnd(32)}│`);
  console.log(`│  Tools:     ${String(tools.length).padEnd(32)}│`);
  console.log(`│  Verbose:   ${String(verboseTools).padEnd(32)}│`);
  if (allowedChatIds.length > 0) {
    console.log(`│  Chats:     ${allowedChatIds.join(", ").slice(0, 32).padEnd(32)}│`);
  } else {
    console.log(`│  Chats:     ⚠ ANY (set ALLOWED_CHAT_IDS!)   │`);
  }
  console.log("├─────────────────────────────────────────────┤");
  console.log("│  Press Ctrl+C to stop                       │");
  console.log("└─────────────────────────────────────────────┘");
  console.log();

  // ── Graceful shutdown ──
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n🛑 Shutting down…");
    await port.close();
    await shutdownMcpServers();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Run the session ──
  await runSession({
    port,
    systemPrompt: getSystemPrompt(context.cwd, tools),
    tools,
    context,
    config,
    onUserMessage: async (text, metadata) => {
      const username = metadata?.fromUsername ?? metadata?.fromUserId ?? "unknown";
      const chatId = metadata?.chatId ?? "?";
      console.log(`[${new Date().toISOString()}] 📩 ${username} (chat ${chatId}): ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`);
      return text;
    },
    onTurnEnd: async (_messages, usage) => {
      console.log(
        `  └─ tokens: ${usage.inputTokens}→${usage.outputTokens}  ` +
        `api: ${Math.round(usage.apiDurationMs)}ms`
      );
    },
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
