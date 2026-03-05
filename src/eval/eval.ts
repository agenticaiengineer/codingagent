import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config/config.js";
import { getClient } from "../core/client.js";
import { printWarning, printInfo } from "../ui/ui.js";
import {
  hasHttpStatus,
  isNonRetryableClientError,
  isAbortError,
  backoffDelay as sharedBackoffDelay,
  abortableSleep,
  retryReasonFromError,
} from "../utils/retry.js";
import { debugLogEval } from "../core/debug.js";
import type { Message, ToolResult } from "../core/types.js";

// ── Constants ──

/**
 * Maximum retries for eval API calls. Lower than the main loop's 3 retries
 * because eval is a non-critical verification step — if all retries fail,
 * we fall back to optimistic completion (assume done) rather than blocking
 * the user indefinitely. This keeps the eval overhead predictable.
 */
const EVAL_MAX_RETRIES = 2;
const EVAL_BASE_DELAY_MS = 1000;
const EVAL_MAX_DELAY_MS = 15_000;

/**
 * Maximum number of eval refinement loops before giving up and accepting
 * the result as-is. This prevents infinite refinement loops when judges
 * disagree perpetually (e.g., one judge always finds a nitpick). 3 rounds
 * is generous — if the work isn't satisfactory after 3 refinement attempts,
 * further iterations yield diminishing returns and waste API credits.
 */
export const MAX_EVAL_ROUNDS = 3;

// ── Types ──

/**
 * A judge evaluates the agent's work from a specific perspective.
 * Multiple judges provide diverse viewpoints — similar to a code review
 * where different reviewers focus on different aspects (correctness,
 * completeness, edge cases, code quality).
 */
export interface JudgePerspective {
  /** Short name for display (e.g., "Correctness", "Completeness"). */
  name: string;
  /** System prompt that establishes this judge's evaluation criteria. */
  systemPrompt: string;
}

/**
 * Result from a single judge's evaluation.
 */
export interface JudgeVerdict {
  /** Which judge perspective produced this verdict. */
  judgeName: string;
  /** Whether the judge considers the work complete. */
  isComplete: boolean;
  /**
   * Explanation of the verdict — why the judge considers the work
   * complete or incomplete. Used both for user visibility and as
   * context for the refinement prompt when the eval fails.
   */
  reasoning: string;
  /**
   * Specific feedback for refinement. Only populated when `isComplete`
   * is false. These are actionable items for the agent to address.
   */
  refinementSuggestions: string[];
}

/**
 * Aggregated result from all judges for a single eval round.
 */
export interface EvalResult {
  /** Individual verdicts from each judge. */
  verdicts: JudgeVerdict[];
  /** Whether a majority of judges consider the work complete. */
  passedMajority: boolean;
  /** Synthesized refinement prompt (empty if passed). */
  refinementPrompt: string;
  /** Which eval round this is (1-based). */
  round: number;
}

// ── Built-in judge perspectives ──

/**
 * Default judge perspectives that evaluate the agent's work from
 * complementary angles. The majority rule means no single perspective
 * can block completion, but a consensus of concerns will trigger
 * refinement.
 *
 * Three judges is a good balance: enough diversity to catch different
 * failure modes, but few enough to keep eval latency low (all judges
 * run in parallel). Three also gives a clear majority (2/3) without tie.
 */
export const DEFAULT_JUDGES: readonly JudgePerspective[] = [
  {
    name: "Correctness",
    systemPrompt: `You are a correctness evaluator. Your job is to determine whether the AI agent's work correctly fulfills the user's original request.

Evaluate:
- Does the output match what the user asked for?
- Are there any logical errors, bugs, or incorrect implementations?
- Do code changes compile/parse correctly (based on syntax)?
- Are edge cases handled appropriately?

You must respond with a JSON object (no markdown fences, no extra text):
{
  "isComplete": true/false,
  "reasoning": "Brief explanation of your assessment",
  "refinementSuggestions": ["suggestion1", "suggestion2"]
}

Set isComplete to true ONLY if the work correctly addresses the user's request.
Set refinementSuggestions to an empty array if isComplete is true.
Be strict on correctness but pragmatic — minor style issues should not block completion.`,
  },
  {
    name: "Completeness",
    systemPrompt: `You are a completeness evaluator. Your job is to determine whether the AI agent's work fully addresses ALL aspects of the user's request.

Evaluate:
- Were all parts of the request addressed, or were some skipped?
- Are there any TODOs, placeholders, or unfinished sections?
- If multiple files/components were involved, were all updated consistently?
- Did the agent handle the full scope or only a subset?

You must respond with a JSON object (no markdown fences, no extra text):
{
  "isComplete": true/false,
  "reasoning": "Brief explanation of your assessment",
  "refinementSuggestions": ["suggestion1", "suggestion2"]
}

Set isComplete to true ONLY if the work comprehensively covers the user's request.
Set refinementSuggestions to an empty array if isComplete is true.
Focus on completeness of the deliverable, not perfection — a working solution that covers all requested aspects is complete even if minor improvements are possible.`,
  },
  {
    name: "Goal Alignment",
    systemPrompt: `You are a goal alignment evaluator. Your job is to determine whether the AI agent's work actually achieves the user's underlying goal — not just the literal request, but the intent behind it.

Evaluate:
- Does the result serve the user's actual need, or does it technically fulfill the request while missing the point?
- Would the user be satisfied with this outcome, or would they need to ask follow-up questions?
- Is the approach appropriate for the problem, or was an overly complex/simple solution chosen?
- Are there any important considerations the agent should have flagged?

You must respond with a JSON object (no markdown fences, no extra text):
{
  "isComplete": true/false,
  "reasoning": "Brief explanation of your assessment",
  "refinementSuggestions": ["suggestion1", "suggestion2"]
}

Set isComplete to true if the work achieves the user's underlying goal effectively.
Set refinementSuggestions to an empty array if isComplete is true.
Be pragmatic — focus on whether the goal is achieved, not whether the approach is optimal. If the work solves the user's problem, it's complete.`,
  },
];

// ── Retry helper ──

function evalBackoffDelay(attempt: number): number {
  return sharedBackoffDelay(attempt, EVAL_BASE_DELAY_MS, EVAL_MAX_DELAY_MS);
}

async function evalCallWithRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EVAL_MAX_RETRIES; attempt++) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      if (isAbortError(err)) throw err;
      if (isNonRetryableClientError(err)) throw err;
      if (attempt >= EVAL_MAX_RETRIES) throw err;
      const delay = evalBackoffDelay(attempt);
      await abortableSleep(delay, signal);
    }
  }
  throw lastError ?? new Error("Unexpected: eval retry loop exhausted");
}

// ── Core eval functions ──

/**
 * Build a concise summary of the conversation for judge evaluation.
 * Extracts the original user request and the agent's work (text outputs
 * and tool actions) to create a focused evaluation context.
 *
 * We don't send the entire conversation to avoid drowning the judge in
 * context — judges need to see what was asked and what was done, not
 * every intermediate thinking step.
 */
function buildEvalContext(messages: Message[]): string {
  if (messages.length === 0) return "(empty conversation)";

  // Extract the original user request (first user message)
  let originalRequest = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        originalRequest = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text);
        if (textBlocks.length > 0) {
          originalRequest = textBlocks.join("\n");
        }
      }
      break;
    }
  }

  // Extract the agent's work: text outputs and tool summaries from the
  // last N messages (capped to keep eval context manageable)
  const recentMessages = messages.slice(-20);
  const workSummary: string[] = [];

  for (const msg of recentMessages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          workSummary.push(`[Assistant]: ${block.text}`);
        } else if (block.type === "tool_use") {
          workSummary.push(`[Tool Call]: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);
        }
      }
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : block.content.map((c) => c.text).join("\n");
          const preview = content.length > 500 ? content.slice(0, 500) + "…" : content;
          const status = block.is_error ? "ERROR" : "OK";
          workSummary.push(`[Tool Result ${status}]: ${preview}`);
        }
      }
    }
  }

  return `## Original User Request\n\n${originalRequest}\n\n## Agent's Work\n\n${workSummary.join("\n\n")}`;
}

/**
 * Run a single judge against the eval context.
 * Makes a non-streaming API call (judges don't need streaming — their
 * output is a single JSON object, not a long narrative).
 */
async function runJudge(
  judge: JudgePerspective,
  evalContext: string,
  signal: AbortSignal
): Promise<JudgeVerdict> {
  const config = getConfig();
  const client = getClient();

  // ── Debug: log eval judge request ──
  debugLogEval({
    phase: "request",
    judgeName: judge.name,
    model: config.smallModel,
    prompt: evalContext,
  });

  const judgeStart = performance.now();
  const response = await evalCallWithRetry(
    () =>
      client.messages.create(
        {
          // Use smallModel for eval to keep costs low.  Eval judges produce
          // structured JSON (~100 tokens), not long code — small models are
          // perfectly capable of this classification task.
          model: config.smallModel,
          max_tokens: 1024,
          system: judge.systemPrompt,
          messages: [
            {
              role: "user" as const,
              content: `Please evaluate the following agent work:\n\n${evalContext}`,
            },
          ],
        },
        { signal }
      ),
    signal
  );

  // Parse the judge's response
  const textContent = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  try {
    // Try to extract JSON from the response — the judge might include
    // markdown fences or preamble text despite being told not to.
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON object found in judge response");
    }
    const parsed = JSON.parse(jsonMatch[0]);

    const verdict: JudgeVerdict = {
      judgeName: judge.name,
      isComplete: Boolean(parsed.isComplete),
      reasoning: String(parsed.reasoning ?? ""),
      refinementSuggestions: Array.isArray(parsed.refinementSuggestions)
        ? parsed.refinementSuggestions.map(String)
        : [],
    };

    // ── Debug: log eval judge response ──
    debugLogEval({
      phase: "response",
      judgeName: judge.name,
      model: getConfig().smallModel,
      verdict: { isComplete: verdict.isComplete, reasoning: verdict.reasoning },
      durationMs: performance.now() - judgeStart,
    });

    return verdict;
  } catch {
    // If parsing fails, treat it as a cautious "incomplete" verdict.
    // This ensures that a malformed judge response doesn't silently
    // approve work that hasn't been properly evaluated.
    return {
      judgeName: judge.name,
      isComplete: false,
      reasoning: `Failed to parse judge response: ${textContent.slice(0, 200)}`,
      refinementSuggestions: ["Re-evaluate — judge response was malformed"],
    };
  }
}

/**
 * Run all judges in parallel and aggregate their verdicts.
 * Uses Promise.allSettled so one judge failure doesn't block others.
 *
 * **Majority rule:** The work is considered complete when more than half
 * of the judges agree it's done. This prevents a single overly-strict
 * judge from blocking completion while still catching genuine issues
 * that multiple judges flag.
 */
export async function evaluateWork(
  messages: Message[],
  signal: AbortSignal,
  judges: readonly JudgePerspective[] = DEFAULT_JUDGES,
  round: number = 1
): Promise<EvalResult> {
  const evalContext = buildEvalContext(messages);

  // Run all judges in parallel
  const judgeResults = await Promise.allSettled(
    judges.map((judge) => runJudge(judge, evalContext, signal))
  );

  // Collect verdicts, treating failed judges as "incomplete" with an
  // explanation. This ensures the majority check accounts for failures
  // rather than silently dropping them (which would inflate the pass rate).
  const verdicts: JudgeVerdict[] = judgeResults.map((result, i) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    const errMsg = result.reason instanceof Error
      ? result.reason.message
      : String(result.reason);
    return {
      judgeName: judges[i].name,
      isComplete: false,
      reasoning: `Judge failed: ${errMsg.slice(0, 200)}`,
      refinementSuggestions: [],
    };
  });

  // Majority rule: more than half must agree it's complete
  const completeCount = verdicts.filter((v) => v.isComplete).length;
  const passedMajority = completeCount > judges.length / 2;

  // Build refinement prompt from failing judges' suggestions
  let refinementPrompt = "";
  if (!passedMajority) {
    const failingVerdicts = verdicts.filter((v) => !v.isComplete);
    const parts: string[] = [
      `The following evaluation judges found issues with the work (round ${round}/${MAX_EVAL_ROUNDS}):\n`,
    ];

    for (const verdict of failingVerdicts) {
      parts.push(`**${verdict.judgeName}**: ${verdict.reasoning}`);
      if (verdict.refinementSuggestions.length > 0) {
        parts.push("Suggestions:");
        for (const suggestion of verdict.refinementSuggestions) {
          parts.push(`  - ${suggestion}`);
        }
      }
      parts.push("");
    }

    parts.push(
      "Please address the issues above and continue working to fully complete the original request. " +
      "Focus on the specific feedback from the judges."
    );

    refinementPrompt = parts.join("\n");
  }

  return {
    verdicts,
    passedMajority,
    refinementPrompt,
    round,
  };
}

/**
 * Build a refinement user message to inject back into the conversation
 * when the eval fails. This becomes the new user message that drives
 * the agent to continue working on the unfinished aspects.
 */
export function buildRefinementMessage(evalResult: EvalResult): Message {
  return {
    role: "user",
    content: evalResult.refinementPrompt,
  };
}
