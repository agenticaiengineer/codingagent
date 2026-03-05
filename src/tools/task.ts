import { MAX_AGENT_DEPTH, SUBAGENT_TYPES, isSubagentType, type Tool, type ToolInput, type ToolContext, type ToolResult } from "../core/types.js";
import { requireString, optionalString, optionalInteger, optionalBool, ToolInputError } from "./validate.js";
import { printWarning } from "../ui/ui.js";

export const taskTool: Tool = {
  name: "Task",
  description:
    "Launch a sub-agent to handle complex, multi-step tasks autonomously. Supports various agent types: Explore, Plan, Bash, general-purpose.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description: "The task for the agent to perform",
      },
      description: {
        type: "string",
        description: "A short description of the task",
      },
      subagent_type: {
        type: "string",
        enum: ["Explore", "Plan", "Bash", "general-purpose"],
        description:
          "The type of agent: Explore, Plan, Bash, general-purpose",
      },
      model: {
        type: "string",
        description: "Optional model override for this agent",
      },
      max_turns: {
        type: "number",
        description: "Maximum agentic turns before stopping",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the agent in the background",
      },
    },
    required: ["prompt"],
  },
  isConcurrencySafe: false,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    try {
      const prompt = requireString(input, "prompt");
      // Reject whitespace-only prompts. `requireString` rejects empty strings
      // but accepts `"   "` or `"\n\t"`, which would spawn a sub-agent with no
      // meaningful task — the sub-agent loop would start, consume an API call
      // with an effectively blank system/user prompt, and produce a confused or
      // generic response. Detect this early and return a clear error before
      // allocating child context, cloning LRU state, and making API calls.
      if (prompt.trim().length === 0) {
        return {
          content: 'Error: "prompt" is empty (whitespace only). Provide a meaningful task description.',
          is_error: true,
        };
      }
      // Reject excessively long prompts. A hallucinated or adversarial multi-MB
      // prompt string would pass `requireString` and the whitespace-only check,
      // then be sent to the API as a user message after full sub-agent setup
      // (context clone, abort controller, LRU state copy) — only to be rejected
      // with "context too long" after a full network round-trip. 100 KB matches
      // the command length limit in bash.ts and is generous for any legitimate
      // sub-agent task description (typical prompts are 100–2000 chars). The cap
      // catches pathological inputs early before allocating child context.
      const MAX_PROMPT_LENGTH = 100_000;
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return {
          content: `Error: prompt is too long (${prompt.length.toLocaleString()} chars, max ${MAX_PROMPT_LENGTH.toLocaleString()}). Provide a more concise task description.`,
          is_error: true,
        };
      }
      const rawSubagentType = optionalString(input, "subagent_type") ?? "general-purpose";
      // Use the shared isSubagentType type guard instead of the previous
      // `includes()` + `as SubagentType` pattern. `Array.prototype.includes`
      // on `readonly string[]` doesn't narrow the type, so the old code
      // required an unsafe `as` cast. The type guard properly narrows the
      // variable so TypeScript can verify the SpawnAgentOptions assignment.
      if (!isSubagentType(rawSubagentType)) {
        return {
          content: `Error: Invalid subagent_type "${rawSubagentType}". Valid types: ${SUBAGENT_TYPES.join(", ")}`,
          is_error: true,
        };
      }
      const subagentType = rawSubagentType; // already narrowed to SubagentType
      // Get the optional model override. `optionalString` now normalizes
      // whitespace-only values to `undefined`, so `"  "` is treated as
      // "no override" — using the config's default model. Previously this
      // required a manual `.trim() || undefined` workaround because
      // `optionalString` only handled empty strings, not whitespace-only ones.
      const model = optionalString(input, "model");
      // Cap model name length to prevent a multi-KB garbage string (from a
      // model hallucination or adversarial prompt) from being sent in the API
      // request. The API would reject it anyway with a 404 "model not found",
      // but the round-trip wastes bandwidth and latency — especially for
      // background agents where the error only surfaces after the full API
      // call completes. 256 chars is generous for any real model identifier
      // (e.g., "anthropic/claude-sonnet-4-20250514" is ~40 chars) while
      // catching obviously invalid values early with a clear error. This
      // matches the control-character validation added to `/model` and
      // `/smallmodel` in index.ts (improvement #26).
      if (model && model.length > 256) {
        return {
          content: `Error: model name is too long (${model.length} chars, max 256). Check the model name for errors.`,
          is_error: true,
        };
      }
      // Reject model names containing control characters (tabs, newlines, null
      // bytes, escape sequences, DEL). These corrupt the API request JSON
      // payload, producing a cryptic 400 "invalid JSON" error with no indication
      // that the model name is the problem. The same validation exists in
      // `/model` and `/smallmodel` commands (index.ts, improvement #26) and in
      // `loadConfig()` at startup — but the Task tool bypasses both of those
      // code paths, accepting the model name directly from the LLM's tool input.
      // A model hallucination or copy-paste artifact embedding invisible control
      // characters would pass the length check above and only fail on the API
      // call, wasting a full sub-agent setup (context clone, abort controller,
      // LRU state copy) and an API round-trip. The regex matches the same
      // character class used in index.ts: [\x00-\x1f\x7f] covers C0 controls
      // (NULL through US) and DEL.
      // eslint-disable-next-line no-control-regex
      if (model && /[\x00-\x1f\x7f]/.test(model)) {
        return {
          content: `Error: model name contains control characters (tabs, newlines, null bytes, etc.) which will corrupt the API request. Remove hidden characters from the model name.`,
          is_error: true,
        };
      }
      const runInBackground = optionalBool(input, "run_in_background") ?? false;
      // Clamp max_turns to [1, MAX_SUBAGENT_TURNS]. Without an upper bound,
      // the model could pass max_turns: 999999, causing a sub-agent to run
      // indefinitely consuming API credits. 200 turns is generous for any
      // legitimate sub-task (typical tasks complete in 10–30 turns), while
      // preventing runaway agents that would burn through the user's budget.
      // Zero or negative values would cause agenticLoop to yield "max turns
      // reached" immediately with no work done, so we clamp to at least 1.
      const MAX_SUBAGENT_TURNS = 200;
      const rawMaxTurns = optionalInteger(input, "max_turns");
      // Warn on non-positive max_turns values. These are silently clamped to 1
      // below, but the model probably intended a different value — a negative
      // max_turns is always a bug (e.g., arithmetic error in the model's
      // reasoning), and 0 means "don't execute at all" which wastes the tool
      // call. The warning is only in the terminal (not the tool result) because
      // the clamping to 1 is a reasonable recovery and the model doesn't need
      // to retry.
      if (rawMaxTurns != null && rawMaxTurns < 1) {
        printWarning(
          `Sub-agent max_turns=${rawMaxTurns} is non-positive — clamping to 1. If you intended more turns, use a positive value.`
        );
      }
      const maxTurns = rawMaxTurns != null
        ? Math.min(Math.max(1, rawMaxTurns), MAX_SUBAGENT_TURNS)
        : undefined;
      // Inform the model when its requested max_turns was clamped. Without
      // this, the model requests e.g. max_turns: 500 but the sub-agent stops
      // after 200 turns — the model has no idea its value was reduced and may
      // be confused by the "early" termination, potentially wasting a turn
      // trying to debug why the agent didn't finish. The warning appears in
      // the tool result text (not just the console) so the model can adapt
      // its strategy (e.g., break the task into smaller pieces).
      let maxTurnsClamped = false;
      if (rawMaxTurns != null && rawMaxTurns > MAX_SUBAGENT_TURNS) {
        maxTurnsClamped = true;
        // Notify the user in the REPL that the requested turn count was
        // reduced. Previously the clamping warning was only included in
        // the tool result text (visible to the model) but not printed to
        // the terminal — so the user had no idea their max_turns value
        // was silently reduced unless they read the sub-agent's output.
        printWarning(
          `Sub-agent max_turns clamped from ${rawMaxTurns} to ${MAX_SUBAGENT_TURNS} (maximum allowed).`
        );
      }
      const description = optionalString(input, "description") ?? "sub-agent task";

      if (!context.spawnAgent) {
        return {
          content:
            "Error: Sub-agent spawning is not available in this context.",
          is_error: true,
        };
      }

      // Guard against excessive depth
      if (context.depth >= MAX_AGENT_DEPTH) {
        return {
          content: `Error: Maximum agent nesting depth (${MAX_AGENT_DEPTH}) reached.`,
          is_error: true,
        };
      }

      // Check if the user has already aborted (Ctrl+C) before spawning the
      // sub-agent. Without this, a queued Task tool call would proceed to
      // create a full child context (cloneContext + AbortController + LRU
      // cache clone) and start an agenticLoop that immediately detects the
      // abort and exits. This is the same pattern used in bash.ts (improvement
      // #25) to avoid wasting resources on already-aborted operations.
      if (context.abortController.signal.aborted) {
        return { content: "Aborted by user.", is_error: true };
      }

      const result = await context.spawnAgent(prompt, {
        subagentType,
        model,
        runInBackground,
        maxTurns,
        description,
      });

      if (runInBackground && result.outputFile) {
        const bgMsg = `Agent started in background.\nAgent ID: ${result.agentId}\nOutput file: ${result.outputFile}`;
        return {
          content: maxTurnsClamped
            ? `Note: max_turns was clamped from ${rawMaxTurns} to ${MAX_SUBAGENT_TURNS} (maximum allowed).\n${bgMsg}`
            : bgMsg,
        };
      }

      // Guard against empty/undefined result: spawnAgent returns result.result
      // as "" when runInBackground is true but outputFile is falsy (shouldn't
      // happen in practice), or when the agent loop produces no assistant_text
      // events (e.g., the model hit the turn limit with only tool calls and no
      // text output). Without this guard, `{ content: "" }` or
      // `{ content: undefined }` is sent as the tool_result, which the API
      // accepts but gives the parent model zero information about what the
      // sub-agent did — it can't distinguish "completed successfully with no
      // output" from "failed silently". A descriptive fallback lets the parent
      // model know the sub-agent ran but produced no text.
      const agentOutput = result.result || "(Sub-agent completed with no text output)";
      return {
        content: maxTurnsClamped
          ? `Note: max_turns was clamped from ${rawMaxTurns} to ${MAX_SUBAGENT_TURNS} (maximum allowed).\n${agentOutput}`
          : agentOutput,
      };
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      // Include the sub-agent type and description in the error message so
      // the parent model (and user) can identify WHICH sub-agent failed when
      // multiple Task calls are in flight. Previously the error was just
      // "Agent error: <message>" with no context — if three sub-agents were
      // spawned in parallel and one failed, the parent model couldn't tell
      // which task to retry or debug.
      //
      // Access `input.subagent_type` and `input.description` directly from
      // the function parameter rather than the `const` variables declared
      // inside the try block (which are out of scope here). Use String() to
      // guard against non-string values since we're bypassing the validation
      // helpers that already ran (or threw) inside the try block.
      const msg = err instanceof Error ? err.message : String(err);
      const agentType = input.subagent_type ? String(input.subagent_type) : "general-purpose";
      const agentDesc = input.description ? String(input.description) : "";
      const subagentLabel = agentDesc ? `${agentType}: ${agentDesc}` : agentType;
      return { content: `Agent error (${subagentLabel}): ${msg}`, is_error: true };
    }
  },
};
