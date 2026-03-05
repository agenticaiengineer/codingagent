import type { Tool } from "../core/types.js";
import type Anthropic from "@anthropic-ai/sdk";
import { printWarning } from "../ui/ui.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { taskTool } from "./task.js";
import { webFetchTool, webSearchTool } from "./web.js";
import { openTool } from "./open.js";
import { transcribeTool } from "./transcribe.js";
import { browserTool } from "./browser.js";

const allTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  taskTool,
  webFetchTool,
  webSearchTool,
  openTool,
  transcribeTool,
  browserTool,
];

/**
 * MCP tools discovered at runtime from connected MCP servers.
 * Kept separate from `allTools` (which is the compile-time built-in set)
 * so that MCP tool additions/removals don't require rebuilding the static
 * indexes. Merged into the result of `getAllTools()` at call time.
 */
const mcpTools: Tool[] = [];

const toolMap = new Map<string, Tool>();
/** Case-insensitive index: lowercase tool name → Tool */
const toolMapCI = new Map<string, Tool>();
for (const tool of allTools) {
  toolMap.set(tool.name, tool);
  toolMapCI.set(tool.name.toLowerCase(), tool);
}

/**
 * Register MCP tools discovered from connected MCP servers.
 * Called by index.ts after `loadMcpServers()` completes.
 * Replaces any previously registered MCP tools (for /reload support).
 */
export function registerMcpTools(tools: Tool[]): void {
  // Clear previous MCP tools from the indexes
  for (const tool of mcpTools) {
    toolMap.delete(tool.name);
    toolMapCI.delete(tool.name.toLowerCase());
  }
  mcpTools.length = 0;

  // Register new MCP tools
  for (const tool of tools) {
    // Skip MCP tools that collide with built-in tool names
    if (toolMapCI.has(tool.name.toLowerCase())) {
      const existing = toolMapCI.get(tool.name.toLowerCase());
      // Only warn if the collision is with a built-in tool (not another MCP tool)
      if (allTools.includes(existing!)) {
        printWarning(
          `MCP tool "${tool.name}" conflicts with built-in tool "${existing!.name}" — skipping.`
        );
        continue;
      }
    }
    mcpTools.push(tool);
    toolMap.set(tool.name, tool);
    toolMapCI.set(tool.name.toLowerCase(), tool);
  }
}

export function getAllTools(): readonly Tool[] {
  if (mcpTools.length === 0) return allTools;
  return [...allTools, ...mcpTools];
}

/**
 * Look up a tool by name. Tries exact match first, then falls back to
 * case-insensitive matching so that LLM-generated names like "read" or
 * "BASH" still resolve correctly instead of returning an unknown-tool error.
 */
export function findTool(name: string): Tool | undefined {
  return toolMap.get(name) ?? toolMapCI.get(name.toLowerCase());
}

export function resolveTools(
  allowed?: string[],
  disallowed?: string[]
): Tool[] {
  let tools = allTools;

  if (allowed) {
    // Build a case-insensitive allow set (lowercase → original name) so that
    // agent definitions using e.g. "read" or "BASH" resolve correctly, matching
    // the case-insensitive fallback in `findTool()`. Previously, `resolveTools`
    // used exact-case `toolMap.has()` for both the unrecognized-name warning and
    // the filter, while `findTool` fell back to case-insensitive matching — an
    // inconsistency that meant `findTool("read")` succeeds but
    // `resolveTools(["read"])` silently produces an empty tool set. This matters
    // when settings.json or custom agent definitions specify tool names in
    // non-canonical casing.
    const allowSetCI = new Set(allowed.map((n) => n.toLowerCase()));

    // Warn about unrecognized tool names — a typo in an agent definition
    // (e.g., "Readd" instead of "Read") would silently give the agent
    // fewer tools than intended, which is hard to debug. Uses the
    // case-insensitive index so casing differences don't trigger false warnings.
    for (const name of allowed) {
      if (!toolMapCI.has(name.toLowerCase())) {
        const known = allTools.map((t) => t.name).join(", ");
        printWarning(
          `resolveTools received unknown tool name "${name}". Known tools: ${known}`
        );
      }
    }
    tools = tools.filter((t) => allowSetCI.has(t.name.toLowerCase()));
  }

  if (disallowed) {
    // Case-insensitive deny matching for consistency with the allow path.
    const denySetCI = new Set(disallowed.map((n) => n.toLowerCase()));
    tools = tools.filter((t) => !denySetCI.has(t.name.toLowerCase()));
  }

  return tools;
}

/**
 * Convert internal Tool definitions to the Anthropic API's tool format.
 * The explicit return type ensures compile-time errors if the Tool schema
 * shape ever diverges from what the API expects.
 */
export function toolsToAnthropicFormat(tools: readonly Tool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}
