import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cloneContext } from "./context.js";
import { resolveTools } from "../tools/index.js";
import { agenticLoop } from "./loop.js";
import { getConfig } from "../config/config.js";
import { safeTruncate } from "../tools/validate.js";
import {
  MAX_AGENT_DEPTH,
  type AgentDefinition,
  type ToolContext,
  type SpawnAgentOptions,
  type AgentResult,
  type Message,
  type SubagentType,
} from "./types.js";

// ── Built-in agent definitions ──

// Use `Record<SubagentType, AgentDefinition>` instead of `Record<string, ...>`
// so TypeScript enforces that every SubagentType has a definition and no extra
// keys can sneak in. If a new SubagentType is added to types.ts, the compiler
// will flag this record as incomplete until a definition is added here.
const AGENT_DEFINITIONS: Record<SubagentType, AgentDefinition> = {
  Explore: {
    name: "Explore",
    model: undefined, // resolved to smallModel at spawn time
    tools: ["Read", "Glob", "Grep"],
    systemPrompt: `You are an exploration agent. Your job is to search and read code to answer questions about the codebase. You have read-only access — use Glob to find files, Grep to search content, and Read to examine files. Be thorough and report your findings concisely.`,
    description: "Fast read-only agent for codebase exploration",
  },

  Plan: {
    name: "Plan",
    model: undefined, // resolved to config.model at spawn time
    tools: ["Read", "Glob", "Grep"],
    systemPrompt: `You are a planning agent. Analyze the codebase to design implementation plans. You have read-only access. Identify critical files, suggest approaches, and consider trade-offs. Return a structured plan.`,
    description: "Software architect agent for designing plans",
  },

  Bash: {
    name: "Bash",
    model: undefined, // resolved to config.model at spawn time
    tools: ["Bash"],
    systemPrompt: `You are a command execution agent. Execute the requested bash commands and report results.`,
    description: "Command execution specialist",
  },

  "general-purpose": {
    name: "general-purpose",
    model: undefined,
    tools: [
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "Task",
      "WebFetch",
      "WebSearch",
    ],
    systemPrompt: `You are a general-purpose coding agent. You have access to all tools. Complete the requested task thoroughly. Search for code, read files, make edits, run commands as needed.`,
    description: "General-purpose agent with all tools",
  },
};

// ── Agent registry for tracking background agents ──

export interface RunningAgent {
  id: string;
  promise: Promise<string>;
  outputFile: string;
  done: boolean;
  result?: string;
  /** @internal Used by abortAllAgents() to cancel in-flight API calls. */
  _abortController?: AbortController;
}

const runningAgents = new Map<string, RunningAgent>();

/**
 * Maximum number of concurrent background agents. Without a cap, the model
 * could spawn dozens of background agents in a single turn, each making its
 * own API calls (consuming credits and rate-limit quota) and holding memory
 * for accumulated results. 10 is generous for any realistic use case while
 * preventing runaway resource consumption.
 */
const MAX_BACKGROUND_AGENTS = 10;

/**
 * Maximum accumulated result size (in characters) for a single sub-agent.
 * Without a cap, an agent producing massive text output (e.g., dumping an
 * entire large file) accumulates unbounded memory in the `results` array.
 * 1 MB of text is generous for any practical agent output while preventing
 * OOM crashes. The result is also written to a temp file, so this limit
 * prevents filling the temp directory with huge files.
 */
const MAX_AGENT_RESULT_CHARS = 1_000_000;

/**
 * Spawn a sub-agent. Clones the parent context, resolves tools for the
 * agent type, and runs the agentic loop.
 *
 * Enforces a maximum nesting depth as a defense-in-depth measure — the
 * Task tool also checks `context.depth`, but this guard prevents runaway
 * recursion if `spawnAgent` is ever called outside the Task tool (e.g.,
 * from another tool or directly wired code).
 */
export async function spawnAgent(
  prompt: string,
  options: SpawnAgentOptions,
  parentContext: ToolContext
): Promise<AgentResult> {
  // Defense-in-depth: reject if the parent is already at or beyond the max depth.
  // The Task tool checks this too, but spawnAgent may be called from other paths.
  if (parentContext.depth >= MAX_AGENT_DEPTH) {
    return {
      result: `Error: Maximum agent nesting depth (${MAX_AGENT_DEPTH}) reached. Cannot spawn further sub-agents.`,
      agentId: "",
    };
  }

  // Reject empty or whitespace-only prompts early — the Anthropic API would
  // return a 400 error for an empty user message, but the error message is
  // generic ("messages: content must be non-empty") and doesn't indicate that
  // the problem originated from the sub-agent's prompt parameter. Catching
  // this here provides an actionable error that helps the model fix its
  // Task tool call.
  if (!prompt || !prompt.trim()) {
    return {
      result: "Error: Agent prompt must be a non-empty string. Provide a clear task description.",
      agentId: "",
    };
  }

  // Reject extremely long prompts. The LLM could hallucinate a prompt
  // containing an entire file's contents or a massive data dump (megabytes),
  // which would be sent to the API as a single user message. The API would
  // reject it with a "context too long" error, but only after transmitting
  // the entire payload — wasting bandwidth, time, and potentially API credits
  // for the upload. 500 KB of text is ~125K tokens, which exceeds the context
  // window of most models. Legitimate sub-agent prompts are typically <10 KB
  // (a paragraph of instructions + code snippets). This guard catches
  // pathological cases early with an actionable error.
  const MAX_PROMPT_CHARS = 500_000;
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      result: `Error: Agent prompt is too long (${(prompt.length / 1000).toFixed(0)}K chars, max ${MAX_PROMPT_CHARS / 1000}K). ` +
        `Summarize the task or pass specific file paths for the agent to read instead of embedding file contents in the prompt.`,
      agentId: "",
    };
  }

  const config = getConfig();
  const agentType = options.subagentType ?? "general-purpose";

  // Validate agent type strictly — don't silently fall back to general-purpose
  // on a typo (e.g., "Exploer" → general-purpose would grant unintended write
  // access to what was meant to be a read-only Explore agent).
  const definition = AGENT_DEFINITIONS[agentType];
  if (!definition) {
    const validTypes = Object.keys(AGENT_DEFINITIONS).join(", ");
    return {
      result: `Error: Unknown agent type "${agentType}". Valid types: ${validTypes}`,
      agentId: "",
    };
  }

  // Resolve model
  const model =
    options.model ??
    definition.model ??
    (agentType === "Explore" ? config.smallModel : config.model);

  // Clone context for isolation
  const childContext = cloneContext(parentContext);

  // Wire up spawnAgent recursively
  childContext.spawnAgent = (p, o) => spawnAgent(p, o, childContext);

  // Resolve tools
  const tools = resolveTools(definition.tools);

  // Build messages
  const messages: Message[] = [
    {
      role: "user",
      content: prompt,
    },
  ];

  const doRun = async (): Promise<string> => {
    const results: string[] = [];
    let totalChars = 0;
    let truncated = false;

    // Track tool executions so we can provide a summary if the sub-agent
    // produces no text output. This is common for Bash-type agents and
    // general-purpose agents that do all their work through tool calls
    // without narrating — the parent model would just see "(No output
    // from agent)" with no indication of what was actually accomplished.
    // The summary includes tool names and truncated results so the parent
    // can decide whether the task succeeded.
    const toolSummaries: string[] = [];
    let toolSuccessCount = 0;
    let toolErrorCount = 0;

    try {
      for await (const event of agenticLoop(
        messages,
        definition.systemPrompt,
        tools,
        childContext,
        model,
        options.maxTurns ?? 30
      )) {
        if (event.type === "assistant_text") {
          // Cap accumulated result size to prevent OOM from agents that
          // produce massive output (e.g., dumping large files or verbose
          // logging). Once the cap is hit, discard further text but
          // continue the loop so tools still execute (the agent may be
          // doing useful work whose results we want even if its text
          // narration is truncated).
          if (!truncated) {
            totalChars += event.text.length;
            if (totalChars > MAX_AGENT_RESULT_CHARS) {
              truncated = true;
              // Keep the portion that fits within the cap.
              // Use safeTruncate instead of slice to avoid splitting a
              // surrogate pair at the cut point — slice operates on UTF-16
              // code units, so cutting between a high surrogate (0xD800–0xDBFF)
              // and its low surrogate (0xDC00–0xDFFF) produces a lone surrogate
              // that causes JSON encoding errors and garbled API responses.
              const excess = totalChars - MAX_AGENT_RESULT_CHARS;
              if (excess < event.text.length) {
                results.push(safeTruncate(event.text, event.text.length - excess));
              }
              results.push(`\n\n[Output truncated — exceeded ${(MAX_AGENT_RESULT_CHARS / 1_000_000).toFixed(0)}M character limit]`);
            } else {
              results.push(event.text);
            }
          }
        } else if (event.type === "tool_result") {
          // Capture a compact summary of each tool execution. Only record
          // up to 20 summaries to prevent unbounded growth in tool-heavy
          // sessions (e.g., an Explore agent scanning 100+ files). The
          // result content is truncated to 200 chars — enough to see
          // success/failure status and key details (file paths, match
          // counts) without flooding the parent's context.
          if (event.result.is_error) {
            toolErrorCount++;
          } else {
            toolSuccessCount++;
          }
          if (toolSummaries.length < 20) {
            const status = event.result.is_error ? "ERROR" : "OK";
            const resultPreview = event.result.content.length > 200
              ? safeTruncate(event.result.content, 200) + "…"
              : event.result.content;
            toolSummaries.push(`  ${event.toolName} [${status}]: ${resultPreview}`);
          } else if (toolSummaries.length === 20) {
            toolSummaries.push("  … (additional tool calls omitted)");
          }
        } else if (event.type === "error") {
          results.push(`[Error: ${event.error}]`);
        } else if (event.type === "turn_complete") {
          // Append the stop reason if it's abnormal so the parent model
          // knows *why* the sub-agent stopped — e.g., "max_tokens" means the
          // model ran out of output tokens mid-response (the answer is likely
          // incomplete), while "end_turn" is the normal termination signal.
          // Previously all stop reasons were silently dropped, so the parent
          // couldn't distinguish a cleanly-finished agent from one that was
          // truncated mid-sentence by a token limit. The parent model would
          // treat both as complete results, missing that a "max_tokens" stop
          // needs a follow-up to get the rest of the answer.
          if (event.stopReason !== "end_turn") {
            results.push(`\n\n[Agent stopped: ${event.stopReason}]`);
          }
        }
      }

      const textOutput = results.join("");
      if (textOutput) {
        return textOutput;
      }

      // No text output — provide tool execution summaries so the parent
      // model knows what the sub-agent actually did. Without this, the
      // parent just sees "(No output from agent)" and has no idea whether
      // files were written, commands were run, or searches were performed.
      // Include success/error counts so the parent model can immediately
      // see whether the sub-agent's work succeeded overall without parsing
      // individual [OK]/[ERROR] statuses in the summary list. This is
      // especially useful when the parent spawned multiple sub-agents — it
      // can quickly identify which one had failures and needs follow-up.
      if (toolSummaries.length > 0) {
        // Use the exact count from the counters — they track every tool_result
        // event, not just the first 20 that were recorded in toolSummaries.
        // Previously this showed "20+" when summaries were truncated, but the
        // actual count is always known precisely (e.g., 47 tool calls should
        // say "47", not "20+"). This helps the parent model accurately assess
        // the sub-agent's workload and decide whether to inspect further.
        const totalCount = String(toolSuccessCount + toolErrorCount);
        const statusSuffix = toolErrorCount > 0
          ? `, ${toolSuccessCount} succeeded, ${toolErrorCount} failed`
          : "";
        return `(Agent produced no text output but executed ${totalCount} tool call${(toolSuccessCount + toolErrorCount) === 1 ? "" : "s"}${statusSuffix})\n\nTool execution summary:\n${toolSummaries.join("\n")}`;
      }

      return "(No output from agent)";
    } finally {
      // Abort the child controller on completion to clean up the propagation
      // listener on the parent's abort signal (see cloneContext). Without this,
      // the listener would persist for the parent's entire lifetime, leaking
      // memory proportional to the number of sub-agent spawns.
      if (!childContext.abortController.signal.aborted) {
        childContext.abortController.abort();
      }
    }
  };

  if (options.runInBackground) {
    // Enforce a cap on concurrent background agents to prevent unbounded
    // resource consumption. Count only agents that are still running
    // (completed agents linger in the registry for 5 minutes for result
    // retrieval, but they don't consume API credits or memory).
    const activeBackgroundCount = Array.from(runningAgents.values())
      .filter((a) => !a.done).length;
    if (activeBackgroundCount >= MAX_BACKGROUND_AGENTS) {
      // Abort the child context since we're not going to use it
      if (!childContext.abortController.signal.aborted) {
        childContext.abortController.abort();
      }
      return {
        result: `Error: Maximum concurrent background agents (${MAX_BACKGROUND_AGENTS}) reached. ` +
          `Wait for existing agents to complete or use /agents to check their status.`,
        agentId: "",
      };
    }

    // Fire-and-forget
    const agentId = childContext.agentId;
    const outputDir = join(tmpdir(), "codingagent-agents");
    // Use mode 0o700 (owner-only rwx) to prevent other users on shared systems
    // from reading agent output files, which may contain sensitive code or data.
    // On Windows, Node ignores the mode parameter, but that's fine since Windows
    // temp directories are already per-user by default (%LOCALAPPDATA%\Temp).
    //
    // Wrap in try/catch because mkdirSync can fail in restricted environments
    // (read-only /tmp in containers, missing TMPDIR, or exhausted inodes).
    // Without this, the error propagates as an unhandled exception from
    // spawnAgent, producing a confusing "EACCES: permission denied, mkdir
    // '/tmp/codingagent-agents'" error with no context that it came from
    // a background agent setup. The agent itself would never start, and the
    // child context's abort listener would leak on the parent's signal because
    // doRun() is never called (its finally block handles cleanup).
    try {
      mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    } catch (mkdirErr: unknown) {
      // Abort the child context since we're not going to use it
      if (!childContext.abortController.signal.aborted) {
        childContext.abortController.abort();
      }
      const msg = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
      return {
        result: `Error: Could not create output directory for background agent: ${msg}. ` +
          `Check that the temp directory (${tmpdir()}) exists and is writable.`,
        agentId: "",
      };
    }
    const outputFile = join(outputDir, `${agentId}.txt`);

    const promise = doRun().then((result) => {
      // Use mode 0o600 (owner-only rw) so agent output files — which may
      // contain sensitive code, API keys, or internal data — aren't readable
      // by other users on shared systems. The parent directory already uses
      // 0o700, but individual files inherit the process umask which may be
      // liberal (e.g., `umask 0000` → world-readable). On Windows, Node
      // ignores the mode parameter, but Windows temp dirs are already per-user.
      //
      // Wrap in try/catch because writeFileSync can fail (disk full, permissions
      // changed, temp dir removed). Without guarding, a write failure throws
      // into the .catch() handler below, and `agent.done`/`agent.result` are
      // never set — the agent stays permanently in a "running" state, blocking
      // one of MAX_BACKGROUND_AGENTS slots forever. The result is still
      // available in memory via agent.result regardless of file write success.
      try {
        writeFileSync(outputFile, result, { encoding: "utf-8", mode: 0o600 });
      } catch { /* best-effort — result is still in agent.result below */ }
      const agent = runningAgents.get(agentId);
      if (agent) {
        agent.done = true;
        agent.result = result;
      }
      // Schedule cleanup: remove from registry after 5 minutes to prevent
      // unbounded growth, while still allowing the caller to retrieve results.
      setTimeout(() => {
        runningAgents.delete(agentId);
        try { unlinkSync(outputFile); } catch { /* best-effort */ }
      }, 5 * 60 * 1000).unref();
      return result;
    }).catch((err: unknown) => {
      // Catch errors to prevent unhandled rejection when doRun() throws
      // (e.g., out of memory, unexpected async generator failure).
      const errorMsg = `[Agent error: ${err instanceof Error ? err.message : String(err)}]`;
      const agent = runningAgents.get(agentId);
      if (agent) {
        agent.done = true;
        agent.result = errorMsg;
      }
      // Abort the child context to clean up the abort propagation listener
      // on the parent's signal (see cloneContext). The `.then()` success path
      // handles this inside doRun()'s `finally` block, but the `.catch()` path
      // fires when doRun() itself throws (before or outside its own try/finally),
      // so the child abort controller would never be aborted — its propagation
      // listener would persist on the parent's signal for the parent's entire
      // lifetime, leaking memory proportional to the number of failed background
      // agent spawns. This matches the cleanup pattern in the non-background
      // `doRun()` finally block (line ~214) and the MAX_BACKGROUND_AGENTS
      // rejection path (line ~229).
      if (!childContext.abortController.signal.aborted) {
        childContext.abortController.abort();
      }
      try { writeFileSync(outputFile, errorMsg, { encoding: "utf-8", mode: 0o600 }); } catch { /* best-effort */ }
      setTimeout(() => {
        runningAgents.delete(agentId);
        try { unlinkSync(outputFile); } catch { /* best-effort */ }
      }, 5 * 60 * 1000).unref();
      return errorMsg;
    });

    runningAgents.set(agentId, {
      id: agentId,
      promise,
      outputFile,
      done: false,
      _abortController: childContext.abortController,
    });

    return { result: "", agentId, outputFile };
  } else {
    // Synchronous execution
    const result = await doRun();
    return { result, agentId: childContext.agentId };
  }
}

/**
 * Get a background agent's result.
 */
export function getAgentResult(agentId: string): RunningAgent | undefined {
  return runningAgents.get(agentId);
}

/**
 * List all currently-tracked background agents (both running and completed).
 * Used by the `/agents` REPL command to give the user visibility into
 * background agent status — previously there was no way to check on background
 * agents without manually reading their output files.
 */
export function listRunningAgents(): ReadonlyArray<Readonly<RunningAgent>> {
  return Array.from(runningAgents.values());
}

/**
 * Abort all running background agents and clear the registry.
 *
 * Background agents hold references to child abort controllers (via
 * `cloneContext`), so aborting them cancels their in-flight API calls.
 * Without this, background agents continue consuming API credits after
 * the user exits the process (they keep the event loop alive via their
 * `doRun()` promises until the API calls complete or time out).
 *
 * Called from the process exit handlers in index.ts.
 */
export function abortAllAgents(): void {
  for (const [, agent] of runningAgents) {
    if (!agent.done) {
      // Abort the child's abort controller to cancel in-flight API calls.
      // Previously the controller was captured only in the doRun() closure
      // and not directly accessible, so abortAllAgents() had no way to
      // actually cancel the agent — it could only mark it as done. Now the
      // controller is stored in the registry entry, so we can abort it
      // directly. This is important when abortAllAgents() is called without
      // also aborting the parent context (e.g., explicit /abort command),
      // since the abort signal propagation from parent→child only works
      // when the parent signal fires.
      if (agent._abortController && !agent._abortController.signal.aborted) {
        agent._abortController.abort();
      }
      agent.done = true;
      agent.result = "[Agent aborted — process exiting]";
    }
    // Best-effort cleanup of the agent's temp output file. The normal
    // cleanup path is a 5-minute setTimeout (line ~277) that is .unref()'d,
    // so it won't fire during process exit — leaving orphaned temp files in
    // the OS temp directory indefinitely. This affects both still-running
    // agents (whose setTimeout hasn't been scheduled yet because doRun()
    // hasn't completed) and completed agents (whose setTimeout was scheduled
    // but won't fire because the event loop is draining). Clean up both.
    if (agent.outputFile) {
      try { unlinkSync(agent.outputFile); } catch { /* best-effort — file may not exist yet */ }
    }
  }
  runningAgents.clear();
}
