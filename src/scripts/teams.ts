#!/usr/bin/env node
/**
 * Microsoft Teams bot entry point.
 *
 * Starts the coding agent as a Teams bot that receives messages via
 * webhook and sends replies through the Bot Connector REST API.
 *
 * ── Prerequisites ─────────────────────────────────────────────────────────
 *
 * 1. Create an Azure Bot resource:
 *    https://portal.azure.com → Create a resource → Azure Bot
 *
 * 2. In the Bot resource, go to Configuration:
 *    - Copy the "Microsoft App ID"
 *    - Create a new client secret → copy the value
 *    - Set the Messaging endpoint to your public URL + /api/messages
 *      e.g., https://your-server.com:3978/api/messages
 *
 * 3. In the Channels section, add "Microsoft Teams"
 *
 * 4. Set environment variables and run:
 *
 *    TEAMS_APP_ID=<your-app-id> \
 *    TEAMS_APP_PASSWORD=<your-client-secret> \
 *    ANTHROPIC_API_KEY=sk-ant-... \
 *    npm run teams
 *
 * ── Environment Variables ──────────────────────────────────────────────────
 *
 *   TEAMS_APP_ID             (required) Microsoft App ID from Azure Bot
 *   TEAMS_APP_PASSWORD       (required) Client secret from Azure Bot
 *   ANTHROPIC_API_KEY        (required) Anthropic API key
 *   TEAMS_PORT               Webhook server port (default: 3978)
 *   TEAMS_HOSTNAME           Bind address (default: 0.0.0.0)
 *   TEAMS_ALLOWED_TENANTS    Comma-separated Azure AD tenant IDs
 *   TEAMS_VERBOSE_TOOLS      Set to "true" to send tool details
 *   TEAMS_SKIP_AUTH          Set to "true" for local dev (INSECURE)
 *
 * ── Tunnel for Local Development ───────────────────────────────────────────
 *
 * Teams requires a public HTTPS endpoint. For local development, use:
 *
 *   # Option A: ngrok
 *   ngrok http 3978
 *
 *   # Option B: VS Code Dev Tunnels
 *   # (built into VS Code — Ctrl+Shift+P → "Forward Port")
 *
 *   # Option C: Cloudflare Tunnel
 *   cloudflared tunnel --url http://localhost:3978
 *
 * Then set the tunneled URL as the Messaging endpoint in Azure Portal:
 *   https://<tunnel-id>.ngrok-free.app/api/messages
 *
 * ── Security ───────────────────────────────────────────────────────────────
 *
 * ⚠️  This bot has FULL ACCESS to the filesystem, shell commands, and the
 * internet. Restrict access via Azure Bot authentication and tenant
 * filtering (TEAMS_ALLOWED_TENANTS).
 *
 * @module teams
 */

import { loadConfig } from "../config/config.js";
import { createContext } from "../core/context.js";
import { getAllTools, registerMcpTools } from "../tools/index.js";
import { spawnAgent } from "../core/agent.js";
import { loadMcpServers, getMcpTools, getMcpInstructions, shutdownMcpServers } from "../core/mcp-client.js";
import { loadProjectMemory, loadSkills, getSkillDescriptions } from "../config/skills.js";
import { TeamsIOPort, type TeamsPortConfig } from "../ports/teams-port.js";
import { runSession } from "../session/session-runner.js";
import type { Tool, ToolContext } from "../core/types.js";

// ── System Prompt ────────────────────────────────────────────────────────────

function getSystemPrompt(cwd: string, tools: readonly Tool[]): string {
  const toolList = tools.map((t) => `- ${t.name}: ${t.description.split("\n")[0]}`).join("\n");

  let prompt = `You are a coding assistant with access to tools for reading, writing, and editing files, searching codebases, and executing commands.

You have access to the following tools:
${toolList}

Important rules:
- Always read a file before editing or overwriting it
- Use Glob and Grep to explore the codebase before making changes
- Be concise in your responses — you are running in Microsoft Teams
- All tool calls are auto-approved — no permission prompts
- Keep responses well-formatted for Teams reading
- Teams supports **bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`, and Adaptive Cards
- You can use markdown freely — Teams has good markdown support

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
  // ── Validate required env vars ──
  // loadConfig() calls loadAllEnv() which populates process.env from
  // .env.teams, .env, settings.json, and secrets.json.
  const config = loadConfig();

  const appId = process.env.TEAMS_APP_ID;
  const appPassword = process.env.TEAMS_APP_PASSWORD;

  if (!appId || !appPassword) {
    console.error(
      "❌ TEAMS_APP_ID and/or TEAMS_APP_PASSWORD are not set.\n\n" +
      "To set up a Teams bot:\n" +
      "  1. Go to https://portal.azure.com → Create resource → Azure Bot\n" +
      "  2. Copy the Microsoft App ID and create a client secret\n" +
      "  3. Set:\n" +
      "     export TEAMS_APP_ID=<your-app-id>\n" +
      "     export TEAMS_APP_PASSWORD=<your-client-secret>\n" +
      "  Or add them to .env.teams\n"
    );
    process.exit(1);
  }

  if (!config.apiKey) {
    console.error("❌ ANTHROPIC_API_KEY is not set.\n  export ANTHROPIC_API_KEY=sk-ant-...\n");
    process.exit(1);
  }

  // ── Parse optional config ──
  const teamsPort = parseInt(process.env.TEAMS_PORT ?? "3978", 10);
  const hostname = process.env.TEAMS_HOSTNAME ?? "0.0.0.0";
  const verboseTools = process.env.TEAMS_VERBOSE_TOOLS === "true";
  const skipAuth = process.env.TEAMS_SKIP_AUTH === "true";
  const allowedTenantIds = process.env.TEAMS_ALLOWED_TENANTS
    ? process.env.TEAMS_ALLOWED_TENANTS.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

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

  // ── Create Teams port ──
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

  // ── Validate credentials ──
  try {
    await port.validateCredentials();
    console.log("✅ Azure Bot credentials validated (OAuth token acquired)");
  } catch (error) {
    console.error(
      "❌ Failed to validate Azure Bot credentials:\n" +
      `   ${error instanceof Error ? error.message : error}\n\n` +
      "Check that TEAMS_APP_ID and TEAMS_APP_PASSWORD are correct.\n" +
      "Get them from: Azure Portal → Bot resource → Configuration\n"
    );
    process.exit(1);
  }

  // ── Print startup banner ──
  console.log("┌──────────────────────────────────────────────────┐");
  console.log(`│  🏢 Teams bot                                    │`);
  console.log("├──────────────────────────────────────────────────┤");
  console.log(`│  App ID:    ${appId.slice(0, 36).padEnd(37)}│`);
  console.log(`│  Model:     ${config.model.padEnd(37)}│`);
  console.log(`│  CWD:       ${context.cwd.slice(0, 37).padEnd(37)}│`);
  console.log(`│  Tools:     ${String(tools.length).padEnd(37)}│`);
  console.log(`│  Verbose:   ${String(verboseTools).padEnd(37)}│`);
  console.log(`│  Endpoint:  http://${hostname}:${teamsPort}/api/messages`.padEnd(51) + "│");
  if (allowedTenantIds.length > 0) {
    console.log(`│  Tenants:   ${allowedTenantIds.join(", ").slice(0, 37).padEnd(37)}│`);
  } else {
    console.log(`│  Tenants:   ALL (multi-tenant)                   │`);
  }
  if (skipAuth) {
    console.log(`│  ⚠️  Auth:    DISABLED (dev mode)                  │`);
  }
  console.log("├──────────────────────────────────────────────────┤");
  console.log("│  Press Ctrl+C to stop                            │");
  console.log("│                                                  │");
  console.log("│  For local dev, expose with:                     │");
  console.log("│    ngrok http 3978                                │");
  console.log("│  Then set Messaging endpoint in Azure Portal to: │");
  console.log("│    https://<id>.ngrok-free.app/api/messages       │");
  console.log("└──────────────────────────────────────────────────┘");
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
      const name = metadata?.fromName ?? "unknown";
      const convId = (metadata?.conversationId as string)?.slice(0, 20) ?? "?";
      console.log(`[${new Date().toISOString()}] 📩 ${name} (${convId}…): ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`);
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
