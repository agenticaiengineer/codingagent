# Agentic Application Testing, Evaluation & Improvement Isolation

## A Deep Research Report

**Date:** February 2026  
**Scope:** Testing methodologies, evaluation frameworks, industry trends, and techniques for isolating model vs. scaffold improvements in agentic AI applications.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Unique Challenge of Testing Agentic Applications](#2-the-unique-challenge-of-testing-agentic-applications)
3. [Taxonomy of Agentic App Testing Approaches](#3-taxonomy-of-agentic-app-testing-approaches)
4. [Industry Benchmarks & Evaluation Suites](#4-industry-benchmarks--evaluation-suites)
5. [Evaluation Metrics: Beyond Pass/Fail](#5-evaluation-metrics-beyond-passfail)
6. [Evaluation Tools & Platforms](#6-evaluation-tools--platforms)
7. [Isolating Model Improvements vs. Scaffold Improvements](#7-isolating-model-improvements-vs-scaffold-improvements)
8. [Practical Testing Patterns for CI/CD](#8-practical-testing-patterns-for-cicd)
9. [LLM-as-Judge: Using Models to Evaluate Models](#9-llm-as-judge-using-models-to-evaluate-models)
10. [Trajectory Evaluation: Judging the Journey, Not Just the Destination](#10-trajectory-evaluation-judging-the-journey-not-just-the-destination)
11. [Statistical Rigor in Agent Evaluation](#11-statistical-rigor-in-agent-evaluation)
12. [Current Industry Trends (2025–2026)](#12-current-industry-trends-20252026)
13. [Recommendations for This Project](#13-recommendations-for-this-project)
14. [References & Further Reading](#14-references--further-reading)

---

## 1. Executive Summary

Testing agentic AI applications is fundamentally different from testing traditional software or even simple LLM-powered applications. Agents are **non-deterministic**, **multi-turn**, **tool-using** systems where the same input can produce different but equally valid outputs via different execution paths. This report examines the state of the art in agentic application testing and evaluation as of early 2026, covering:

- **How** teams test agentic apps (multi-layered evaluation pyramids, trajectory analysis, LLM-as-judge)
- **What** the current trends are (benchmark evolution, observability platforms, automated red-teaming)
- **How** to evaluate improvements (A/B testing, controlled experiments, regression suites)
- **How** to isolate model improvements from scaffold/application improvements (ablation studies, cross-model evaluation, fixed-scaffold testing)

**Key finding:** The most successful teams employ a **three-tier evaluation pyramid** — deterministic unit tests at the base, LLM-as-judge evaluation in the middle, and human evaluation at the top — combined with rigorous **ablation methodology** to separate the effects of model upgrades from scaffolding changes.

---

## 2. The Unique Challenge of Testing Agentic Applications

### 2.1 Why Traditional Testing Falls Short

Traditional software testing assumes:
- **Deterministic outputs** — same input → same output
- **Binary correctness** — pass or fail
- **Isolated units** — components can be tested independently
- **Fast execution** — tests complete in milliseconds

Agentic applications violate all of these assumptions:

| Property | Traditional Software | Agentic Application |
|---|---|---|
| Determinism | Deterministic | Stochastic (temperature, sampling) |
| Correctness | Binary (pass/fail) | Spectrum (partially correct, different valid approaches) |
| Isolation | Easy to mock | Deep integration with LLM, tools, environment |
| Speed | Milliseconds | Seconds to minutes per test case |
| Cost | Free to run | $0.01–$5+ per test case (API costs) |
| State | Stateless or easily controlled | Multi-turn stateful conversations |
| Output format | Structured | Free-form text + tool calls + side effects |

### 2.2 The Dual Nature of Agent Performance

An agentic application's performance is a function of two intertwined components:

$$P_{\text{agent}} = f(P_{\text{model}}, P_{\text{scaffold}})$$

Where:
- $P_{\text{model}}$ = the underlying LLM's reasoning, coding, and instruction-following capabilities
- $P_{\text{scaffold}}$ = the application layer — prompts, tools, routing logic, error handling, context management, retry strategies, and evaluation/refinement loops

These two factors interact **non-linearly**. A scaffold optimization that helps a weaker model might actually hurt a stronger one (and vice versa). This makes evaluation and attribution of improvements particularly challenging.

### 2.3 The Compounding Error Problem

Agents operate over multiple turns. Each turn introduces potential error, and errors compound:

$$P_{\text{success}} = \prod_{i=1}^{n} P_{\text{correct\_turn}_i}$$

For an agent that takes 20 turns with 95% per-turn accuracy:

$$P_{\text{success}} = 0.95^{20} \approx 0.36$$

This means even a small per-turn improvement can dramatically affect end-to-end success rates, making evaluation at both the turn level and task level essential.

---

## 3. Taxonomy of Agentic App Testing Approaches

### 3.1 The Evaluation Pyramid

Based on industry best practices (notably articulated by Hamel Husain and adopted broadly), the recommended approach is a **three-tier evaluation pyramid**:

```
            ┌─────────────┐
            │   Level 3   │  A/B Testing / Human Evaluation
            │  (Expensive) │  Real users, real tasks
            ├─────────────┤
            │   Level 2   │  LLM-as-Judge / Model-Based Eval
            │  (Moderate)  │  Automated quality scoring
            ├─────────────┤
            │   Level 1   │  Deterministic Unit Tests
            │   (Cheap)    │  Assertions, format checks, tool call validation
            └─────────────┘
```

**Level 1: Deterministic Unit Tests**
- Run on every code change
- Fast, cheap, no LLM calls needed
- Test: output format, tool call schemas, error handling, edge cases
- Example: "Does the agent produce valid JSON for tool calls?"
- Example: "Does the Read tool reject relative paths?"
- Example: "Are file paths properly escaped?"

**Level 2: LLM-as-Judge Evaluation**
- Run on a cadence (nightly, per-PR)
- Moderate cost (uses cheaper/smaller judge models)
- Test: correctness, completeness, goal alignment
- Example: "Did the agent's code change compile?"
- Example: "Does the response address all parts of the user's request?"

**Level 3: Human Evaluation + A/B Testing**
- Run after significant changes
- Expensive, slow, but highest fidelity
- Test: real-world usefulness, user satisfaction
- Example: "Would a developer accept this code change?"

### 3.2 Testing Dimensions

A comprehensive agent testing strategy evaluates across multiple dimensions:

#### 3.2.1 Task Completion (Outcome-Based)
- Did the agent accomplish the user's goal?
- Was the output correct?
- Were all sub-tasks addressed?

#### 3.2.2 Trajectory Quality (Process-Based)
- Did the agent take a reasonable path to the solution?
- Were the right tools used in the right order?
- Was the agent efficient (minimal unnecessary steps)?
- Did the agent recover gracefully from errors?

#### 3.2.3 Safety & Guardrails
- Did the agent stay within its authorized boundaries?
- Were any dangerous operations attempted?
- Did the agent hallucinate tool results or file contents?

#### 3.2.4 Reliability & Consistency
- Given the same task K times, how often does the agent succeed? (pass@k)
- How much does performance variance affect user experience?
- Are there catastrophic failure modes?

#### 3.2.5 Cost & Efficiency
- How many tokens were consumed?
- How many API calls were made?
- What was the wall-clock time?
- What was the dollar cost per task?

---

## 4. Industry Benchmarks & Evaluation Suites

### 4.1 SWE-bench (Software Engineering Benchmark)

**The dominant benchmark for coding agents as of 2026.**

- **What it is:** 2,294 real GitHub issues from 12 popular Python repositories, paired with ground-truth pull requests and unit tests.
- **How it works:** An agent is given a codebase + issue description and must produce a patch. The patch is evaluated against the real unit tests from the original PR.
- **Key variants:**
  - **SWE-bench Full** — the original 2,294 tasks
  - **SWE-bench Lite** — a 300-task easier subset
  - **SWE-bench Verified** — 500 tasks human-verified to be solvable and fairly graded (created by OpenAI + SWE-bench team)
  - **SWE-bench Multimodal** — tasks requiring visual understanding
  - **SWE-bench Multilingual** — tasks beyond Python
  - **SWE-bench Bash Only** — constraining agents to bash-only tooling

**Why it matters for scaffold vs. model isolation:**
SWE-bench explicitly evaluates the **entire agent system** (model + scaffold), not the model alone. The leaderboard shows both the model and the scaffold used, making it possible to compare the same model across different scaffolds and vice versa. For example, on SWE-bench Lite, GPT-4's performance varied from 2.7% (early RAG scaffold) to 28.3% (CodeR scaffold) — a **10× difference** from scaffolding alone.

**State of the art (Feb 2026):**
- Claude 4.5 Opus (high reasoning) on mini-swe-agent v2.0.0: **76.8%** on Bash-Only
- Top SWE-bench Verified scores approaching 70%+

**Limitations:**
- Only Python repositories
- Static dataset → contamination risk
- Some tasks have overly specific unit tests
- Doesn't measure code quality, only correctness
- Environment setup issues can cause false failures

### 4.2 AgentBench

- **What it is:** Multi-dimensional benchmark with 8 distinct environments (OS interaction, database, knowledge graph, digital card game, lateral thinking puzzles, house-holding, web shopping, web browsing)
- **Key finding:** Large gap between commercial and open-source models in agent performance; poor long-term reasoning and instruction following are primary failure modes
- **Published:** ICLR 2024

### 4.3 HumanEval / MBPP / EvalPlus

Classic **code generation** benchmarks (not agentic), but important as baselines:
- **HumanEval:** 164 hand-crafted Python problems (pass@k metric)
- **MBPP:** 974 crowd-sourced Python problems
- **EvalPlus:** Augmented versions with more tests
- These measure raw model coding ability, useful for isolating model-level improvements

### 4.4 LMSYS Chatbot Arena / ELO Rating

- **What it is:** Crowdsourced head-to-head comparisons where humans choose the better response
- **How it works:** Random assignment of two models → human vote → ELO rating calculation
- **Why it matters:** The gold standard for overall model quality ranking, but doesn't specifically measure agentic capabilities
- **Relevance:** Provides a model-level quality signal independent of any scaffold

### 4.5 Other Notable Benchmarks

| Benchmark | Focus | Agent-Specific? |
|---|---|---|
| **WebArena** | Web browsing tasks | Yes |
| **OSWorld** | Operating system interaction | Yes |
| **GAIA** | General AI Assistant tasks | Yes |
| **ML-Bench** | ML engineering tasks | Yes |
| **Aider Polyglot** | Multi-language code editing | Yes |
| **Terminal Bench** | Command-line tasks | Yes |
| **Tau-bench** | Customer service agent tasks | Yes |

---

## 5. Evaluation Metrics: Beyond Pass/Fail

### 5.1 Core Metrics

#### pass@k
The probability that at least one of $k$ attempts solves the problem:

$$\text{pass@}k = 1 - \frac{\binom{n-c}{k}}{\binom{n}{k}}$$

Where $n$ = total attempts, $c$ = correct attempts. This is critical for agents because:
- Stochastic behavior means a single attempt may not represent true capability
- pass@1 measures reliability, pass@5 measures capability with retries
- The gap between pass@1 and pass@5 indicates how much retry logic could help

#### Resolve Rate (SWE-bench Specific)
Simple percentage of tasks where all FAIL_TO_PASS and PASS_TO_PASS tests pass.

#### Cost-Adjusted Performance
$$\text{Efficiency} = \frac{\text{Resolve Rate}}{\text{Average Cost per Task}}$$

Important because a scaffold that achieves 80% at $5/task may be worse than one achieving 70% at $0.50/task, depending on use case.

### 5.2 Trajectory Metrics

#### Tool Call Accuracy
$$\text{TCA} = \frac{\text{Correct tool calls}}{\text{Total tool calls}}$$

#### Trajectory Efficiency
$$\text{TE} = \frac{\text{Minimum possible steps}}{\text{Actual steps taken}}$$

#### Recovery Rate
$$\text{RR} = \frac{\text{Errors recovered from}}{\text{Total errors encountered}}$$

#### Unnecessary Action Rate
Percentage of actions that didn't contribute to the solution — indicates wasted tokens and user patience.

### 5.3 Quality Metrics (Beyond Correctness)

For coding agents specifically:
- **Code quality:** Does the fix follow the repository's style?
- **Minimal diff:** Is the change minimal and focused?
- **No regression:** Does the fix break anything else?
- **Explanation quality:** Did the agent explain what it did and why?

### 5.4 Reliability Metrics

- **Success rate variance** across multiple runs
- **Failure mode distribution** — what types of failures occur?
- **Graceful degradation** — when the agent fails, does it fail safely?
- **Context window utilization** — does the agent exhaust context before completing?

---

## 6. Evaluation Tools & Platforms

### 6.1 Evaluation Frameworks

| Tool | Type | Key Features |
|---|---|---|
| **Braintrust** | Commercial Platform | Experiments, datasets, scoring, comparison, observability |
| **LangSmith** | Commercial Platform | Trace logging, evaluation datasets, human annotation |
| **promptfoo** | Open-source CLI | Test-driven eval, red-teaming, CI/CD integration |
| **Arize Phoenix** | Open-source + Commercial | Observability, trace analysis, evaluation |
| **Weights & Biases (Weave)** | Commercial Platform | Experiment tracking, LLM evaluation |
| **Humanloop** | Commercial Platform | Prompt management, evaluation, feedback |
| **Autoevals** | Open-source Library | Factuality, similarity, and other auto-scorers |

### 6.2 Braintrust's Approach (Representative of Industry Trend)

Braintrust exemplifies the modern evaluation platform approach:

1. **Define components:** Data (test cases), Task (the function under test), Scores (evaluation criteria)
2. **Run evaluations:** Programmatically via `Eval()` function or CLI
3. **Interpret results:** Summary metrics, per-case scores, traces
4. **Compare experiments:** Side-by-side diffing of prompt/model/scaffold changes
5. **Continuous loop:** Offline experiments → deploy → online monitoring → feed back into datasets

```typescript
import { Eval } from "braintrust";
import { Factuality } from "autoevals";

Eval("Coding Agent", {
  data: () => testCases,
  task: async (input) => await runAgent(input),
  scores: [Factuality, TaskCompletion, CodeQuality],
});
```

### 6.3 promptfoo's Approach

promptfoo emphasizes **test-driven LLM development**:

```yaml
# promptfoo config
prompts:
  - "You are a coding assistant..."
providers:
  - anthropic:claude-sonnet-4-20250514
  - anthropic:claude-3-5-haiku-20241022
tests:
  - vars:
      task: "Fix the bug in auth.ts"
    assert:
      - type: contains
        value: "auth.ts"
      - type: llm-rubric
        value: "The response correctly identifies and fixes the authentication bug"
```

Key advantages:
- **Declarative test cases** — no code required
- **Matrix evaluation** — test across multiple prompts × models × inputs
- **CI/CD native** — runs in GitHub Actions, etc.
- **Red-teaming built in** — automated adversarial testing

---

## 7. Isolating Model Improvements vs. Scaffold Improvements

### 7.1 Why This Is Hard

This is the **central methodological challenge** of agentic application development. When you upgrade from Claude 3.5 Sonnet to Claude 4 Opus and simultaneously improve your error-handling logic, and your SWE-bench score goes from 40% to 55%, how much of that improvement came from each change?

The difficulty arises from **non-linear interactions:**
- A better model might make a complex retry strategy unnecessary
- A model that was too dumb for multi-file edits might now succeed with them, but only because your scaffold provides the right tools
- Prompt optimizations tuned for one model may actually harm performance on a different model

### 7.2 Ablation Study Methodology

The gold standard approach, borrowed from ML research:

#### 7.2.1 Full Factorial Design

Test every combination of model × scaffold variant:

| | Scaffold v1 | Scaffold v2 |
|---|---|---|
| **Model A** | Baseline (e.g., 40%) | Scaffold-only improvement? (e.g., 45%) |
| **Model B** | Model-only improvement? (e.g., 48%) | Combined improvement (e.g., 55%) |

This gives you:
- **Scaffold improvement** = average of (Scaffold v2 scores - Scaffold v1 scores) across models
- **Model improvement** = average of (Model B scores - Model A scores) across scaffolds
- **Interaction effect** = the remainder that can't be attributed to either alone

#### 7.2.2 Controlled Variable Testing

**To measure scaffold improvement:**
1. Fix the model (same model, same version, same temperature)
2. Change only the scaffold
3. Run against the same test suite
4. Compare results

**To measure model improvement:**
1. Fix the scaffold (same code, same prompts, same tools)
2. Change only the model
3. Run against the same test suite
4. Compare results

#### 7.2.3 Component-Level Ablation

For scaffold changes, test each component change independently:

```
Baseline:           40.0%
+ Better prompts:   42.5%  (+2.5% from prompts)
+ Better tools:     44.0%  (+1.5% from tools)
+ Error recovery:   46.0%  (+2.0% from error recovery)
+ Eval loop:        48.5%  (+2.5% from eval loop)
All combined:       49.0%  (vs. sum of 48.5% — interaction effects exist)
```

### 7.3 The SWE-bench Evidence

SWE-bench provides compelling real-world evidence for the scaffold vs. model separation:

**Same model, different scaffolds:**
- GPT-4 on SWE-bench Lite: 2.7% (RAG scaffold) → 28.3% (CodeR scaffold)
- This is a **10.5× improvement** from scaffolding alone

**Same scaffold, different models (Anthropic's mini-swe-agent v2.0.0, Feb 2026 data):**
- Claude 4.5 Opus (high reasoning): **76.8%**
- Gemini 3 Flash (high reasoning): lower scores
- Same scaffold, dramatically different results → model matters enormously

**Key insight from Anthropic's SWE-bench work:**
> "The performance of an agent on SWE-bench can vary significantly based on this scaffolding, even when using the same underlying AI model."

And conversely:
> "We actually spent more time optimizing our tools than the overall prompt."

### 7.4 Practical Isolation Techniques

#### 7.4.1 Model Fingerprinting Tests

Create a small set of tasks that specifically test **model-level capabilities** independent of the scaffold:
- Raw code generation (single-turn, no tools)
- Reasoning problems (logic puzzles, math)
- Instruction following (format compliance)

Changes in these scores indicate model-level improvements.

#### 7.4.2 Scaffold Stress Tests

Create tasks that specifically test **scaffold-level capabilities:**
- Error recovery (inject tool failures and see if scaffold retries)
- Context management (tasks that exceed context window — does scaffold compact?)
- Tool routing (does the scaffold suggest the right tools?)
- Multi-step coordination (does the scaffold maintain state across turns?)

Changes in these scores indicate scaffold-level improvements.

#### 7.4.3 Cross-Model Regression Matrix

Maintain a test suite that runs across every supported model:

```
         Claude 3.5  Claude 4  GPT-4o  Gemini 2
v1.0        45%       52%      41%      38%
v1.1        47%       54%      41%      38%    ← scaffold change helped Claude but not GPT/Gemini
v1.2        47%       54%      43%      40%    ← scaffold change helped all models
v2.0        47%       56%      43%      40%    ← only Claude 4 improved → model-specific optimization
```

#### 7.4.4 Dated Model Snapshots

Always pin model versions (e.g., `claude-sonnet-4-20250514` not `claude-sonnet-4-latest`) in evaluation runs. This ensures:
- Historical results remain comparable
- Model provider updates don't silently change your baseline
- You can re-run old scaffold versions against new models

### 7.5 Attribution Framework

For each improvement, document:

```markdown
## Change: Added file-content caching to reduce redundant Read calls
- **Type:** Scaffold improvement
- **Evidence:** 
  - Same model (Claude 3.5 Sonnet), same test suite
  - Before: 42.3% resolve rate, avg 15.2 tool calls/task
  - After: 43.8% resolve rate, avg 12.1 tool calls/task
  - Cost reduction: 18% fewer tokens per task
- **Interaction effects:** Not tested across other models yet
```

---

## 8. Practical Testing Patterns for CI/CD

### 8.1 The Testing Diamond for Agents

Unlike the traditional testing pyramid, agentic apps need a **testing diamond** — wide in the middle where LLM-based evaluation lives:

```
        ┌───┐
        │ E2E │  Full end-to-end agent runs (expensive, nightly)
      ┌─┤     ├─┐
      │ └─────┘ │
    ┌─┤ LLM-as- ├─┐  LLM-based quality scoring (moderate, per-PR)
    │ │  Judge  │ │
    │ └─────────┘ │
    │  Assertions │  Format, schema, safety checks (cheap, every commit)
    └─────────────┘
```

### 8.2 What to Test at Each Stage

#### On Every Commit (< 1 minute, $0)
```typescript
// Deterministic tests — no LLM calls
test("tool calls have valid schemas", () => { ... });
test("system prompt includes required instructions", () => { ... });
test("error messages are properly formatted", () => { ... });
test("context window limits are enforced", () => { ... });
test("tool responses are properly truncated", () => { ... });
```

#### On Every PR (< 10 minutes, ~$1–5)
```typescript
// Small set of representative tasks with LLM-as-judge scoring
const SMOKE_TESTS = [
  { input: "Read and explain main.ts", expectedTools: ["Read"] },
  { input: "Find all TODO comments", expectedTools: ["Grep"] },
  { input: "Create a hello world file", expectedTools: ["Write"] },
];

for (const test of SMOKE_TESTS) {
  const result = await runAgent(test.input);
  const score = await judgeCompletion(result, test);
  expect(score).toBeGreaterThan(0.7);
}
```

#### Nightly (< 2 hours, ~$50–200)
```typescript
// Full suite of 50–200 representative tasks
// Run against pinned model version
// Compare against previous nightly baseline
// Alert on regressions > 5%
const results = await runFullEvalSuite(pinnedModel, testSuite);
compareToBaseline(results, lastNightlyResults);
```

#### On Model Upgrade (< 4 hours, ~$200–1000)
```typescript
// Full suite against both old and new model
// Same scaffold code
// Statistical comparison with confidence intervals
const oldResults = await runFullEvalSuite(oldModel, testSuite);
const newResults = await runFullEvalSuite(newModel, testSuite);
compareWithStatisticalSignificance(oldResults, newResults);
```

### 8.3 Mock Strategies for LLM Calls

For deterministic testing without LLM costs:

#### 8.3.1 Recorded Interactions (VCR Pattern)
Record real LLM interactions, replay them in tests:
```typescript
// Record mode
const recorder = new LLMRecorder("fixtures/read-file-task.json");
const result = await runAgent(input, { recorder });

// Replay mode
const replayer = new LLMReplayer("fixtures/read-file-task.json");
const result = await runAgent(input, { replayer });
expect(result.toolCalls).toMatchSnapshot();
```

**Pros:** Fast, deterministic, free  
**Cons:** Breaks when prompts change, doesn't test LLM quality

#### 8.3.2 Synthetic Tool Responses
Mock the tool execution layer, keep real LLM calls:
```typescript
const mockTools = {
  Read: (path) => "// mock file content",
  Bash: (cmd) => "mock output",
};
const result = await runAgent(input, { tools: mockTools });
```

**Pros:** Tests actual LLM behavior, controls tool side effects  
**Cons:** Still costs money, mock fidelity matters

#### 8.3.3 Deterministic LLM Stub
Replace LLM with a rule-based system for scaffold testing:
```typescript
const stubLLM = (messages) => {
  if (lastMessage.includes("read the file")) {
    return { toolCalls: [{ name: "Read", input: { path: "/test.ts" } }] };
  }
  return { text: "I'll help with that." };
};
```

**Pros:** Fast, free, deterministic  
**Cons:** Only tests scaffold logic, not LLM integration

### 8.4 Cost Management

| Strategy | Cost Reduction | Trade-off |
|---|---|---|
| Use smaller model for judge | 5–10× cheaper | Slightly less accurate judging |
| Cache LLM responses | Variable | Stale cache risks |
| Run full suite nightly, smoke tests per-PR | 10–50× cheaper | Delayed regression detection |
| Subsample test suite | Proportional | Reduced coverage |
| Pin temperature=0 | No cost change | Reduced variance → fewer runs needed |
| Set max_tokens limits | Proportional | May truncate valid responses |

---

## 9. LLM-as-Judge: Using Models to Evaluate Models

### 9.1 The Pattern

Use a (typically stronger or equal) LLM to evaluate the output of the agent being tested. This is the approach our existing `eval.ts` uses with its three-judge panel (Correctness, Completeness, Goal Alignment).

### 9.2 Best Practices

#### 9.2.1 Judge Model Selection
- Use the **most powerful model you can afford** for judging
- Judge models produce short outputs (~100 tokens), so cost is low even with expensive models
- A weaker model judging a stronger model's output is unreliable

#### 9.2.2 Multi-Judge Panel (Our Current Approach)
Our eval.ts uses three judges with majority voting — this is well-aligned with industry best practices:
- **Correctness** — Does the output match what was asked?
- **Completeness** — Were all parts addressed?
- **Goal Alignment** — Does it serve the user's underlying intent?

The majority rule (2/3 must agree) prevents overly strict individual judges from blocking valid completions.

#### 9.2.3 Calibration Against Human Judgment
The critical step most teams skip:
1. Have humans label a set of agent outputs (good/bad)
2. Run the same outputs through the LLM judge
3. Measure agreement (precision, recall, F1 — not just raw agreement)
4. Iterate on judge prompts until agreement is high
5. **Continue periodic calibration** — model updates can shift judge behavior

Hamel Husain's recommended approach:
> "Use low-tech solutions like Excel to iterate on aligning model-based eval with humans. Send a spreadsheet with model response, model critique, model outcome, and have a human fill in their own critique and outcome."

#### 9.2.4 Structured Output from Judges
Always require JSON output from judges (as our eval.ts does):
```json
{
  "isComplete": true,
  "reasoning": "The agent correctly identified and fixed the bug...",
  "refinementSuggestions": []
}
```

This enables automated aggregation and tracking.

### 9.3 Limitations of LLM-as-Judge

- **Self-bias:** Models tend to rate their own outputs higher (Claude judges tend to prefer Claude outputs)
- **Position bias:** In head-to-head comparisons, models prefer the first or second response depending on prompt framing
- **Length bias:** Longer responses are often rated higher regardless of quality
- **Sycophancy:** Judge models may be reluctant to criticize
- **Inability to execute:** Judges can't actually run code to verify it works

### 9.4 Mitigations

| Bias | Mitigation |
|---|---|
| Self-bias | Use a different model family for judging |
| Position bias | Randomize presentation order, average across orderings |
| Length bias | Explicitly instruct judge to ignore length |
| Sycophancy | Include negative examples in judge prompt |
| Can't execute | Combine LLM-judge with actual execution tests |

---

## 10. Trajectory Evaluation: Judging the Journey, Not Just the Destination

### 10.1 Why Trajectory Matters

Two agents might both produce a correct fix, but via very different paths:

**Agent A (efficient):**
1. Read file → 2. Identify bug → 3. Fix bug → 4. Verify → Done (4 steps)

**Agent B (wasteful):**
1. Read file → 2. Read wrong file → 3. Read another wrong file → 4. Read correct file → 5. Misdiagnose bug → 6. Apply wrong fix → 7. See test failure → 8. Re-read file → 9. Correctly diagnose → 10. Fix → 11. Verify → Done (11 steps)

Both succeed, but Agent A costs 3× less and is 3× faster.

### 10.2 Trajectory Scoring Dimensions

| Dimension | What It Measures | How to Score |
|---|---|---|
| **Efficiency** | Steps to completion | `min_steps / actual_steps` |
| **Focus** | Relevance of actions | `relevant_actions / total_actions` |
| **Error Recovery** | Ability to self-correct | `errors_recovered / errors_encountered` |
| **Tool Selection** | Using the right tool | `correct_tool_choices / total_tool_choices` |
| **Progressive Refinement** | Getting closer to solution | Monotonic decrease in distance to solution |

### 10.3 Practical Trajectory Evaluation

```typescript
interface TrajectoryMetrics {
  totalSteps: number;
  toolCallCount: Record<string, number>;
  errorCount: number;
  recoveryCount: number;
  totalTokensUsed: number;
  wallClockTimeMs: number;
  backtrackCount: number;  // How often did the agent undo/redo work
  redundantReadCount: number;  // How often did it re-read the same file
}

function evaluateTrajectory(trajectory: AgentTrace): TrajectoryMetrics {
  // Analyze the sequence of agent actions
  // Flag redundant operations
  // Measure error recovery
  // Calculate efficiency ratios
}
```

### 10.4 Trajectory-Aware Benchmarking

When comparing scaffold versions, trajectory metrics can reveal improvements invisible to outcome-only metrics:

```
                    v1.0    v1.1    Improvement
Resolve rate:       45%     45%     ← No change (misleading!)
Avg steps/task:     18.3    12.7    ← 30% fewer steps
Avg cost/task:      $1.20   $0.85   ← 29% cheaper
Error recovery:     42%     68%     ← Much better recovery
```

---

## 11. Statistical Rigor in Agent Evaluation

### 11.1 Sample Size and Significance

Agent evaluations are expensive, so teams often run too few samples. Key considerations:

#### 11.1.1 How Many Runs Per Task?
Due to stochastic behavior, a single run can be misleading. For reliable estimates:

$$n = \frac{z^2 \cdot p(1-p)}{E^2}$$

For 95% confidence and ±5% margin of error with an expected pass rate of 50%:

$$n = \frac{1.96^2 \cdot 0.5 \cdot 0.5}{0.05^2} = 384$$

In practice, most teams run 1–3 attempts per task due to cost constraints, accepting higher uncertainty.

#### 11.1.2 Confidence Intervals

Always report confidence intervals, not just point estimates:
- "45.2% ± 4.3% (95% CI)" is much more informative than "45.2%"
- For binomial outcomes (pass/fail), use the Wilson score interval

#### 11.1.3 Paired Comparisons

When comparing two scaffolds, use **paired evaluation** — run both on the same tasks:
- McNemar's test for statistical significance
- Focus on **disagreements** (tasks where one passes and the other fails)
- A small number of disagreements means the difference may not be significant

### 11.2 Avoiding Common Statistical Pitfalls

| Pitfall | Why It's Dangerous | Mitigation |
|---|---|---|
| Cherry-picking examples | Confirmation bias | Use fixed, pre-defined test suites |
| Overfitting to benchmark | High score, poor real-world performance | Hold out test tasks; use diverse benchmarks |
| Contamination | Model may have seen test data in training | Use temporal splits; create novel test cases |
| Multiple comparisons | Testing many configs inflates false positives | Bonferroni correction; pre-register experiments |
| Survivorship bias | Only studying successful runs | Analyze failure modes equally |

### 11.3 Contamination Detection

Benchmark contamination (model training data including benchmark tasks) is a growing concern:

- **Temporal contamination:** SWE-bench tasks come from public GitHub repos, widely available in training data
- **Mitigation strategies:**
  - Create private, unpublished test tasks
  - Use tasks created after model training cutoff
  - Periodically refresh benchmark tasks
  - Use "canary" tasks — intentionally distinctive tasks you can detect in model outputs

---

## 12. Current Industry Trends (2025–2026)

### 12.1 Trend: Scaffold Simplification

Anthropic's "Building Effective Agents" guidance (Dec 2024, still highly influential) pushed the industry toward **simpler scaffolds:**

> "Consistently, the most successful implementations weren't using complex frameworks or specialized libraries. Instead, they were building with simple, composable patterns."

The Agentless paper demonstrated that a simple three-phase approach (localize → repair → validate) could match or beat complex agent scaffolds on SWE-bench, questioning whether complex autonomous agents are even necessary.

**Implication for testing:** Simpler scaffolds are easier to test, debug, and reason about. The trend toward simplicity reduces the evaluation burden.

### 12.2 Trend: Agent-Computer Interfaces (ACI) as First-Class Citizens

Anthropic's experience optimizing for SWE-bench revealed:

> "We actually spent more time optimizing our tools than the overall prompt."

This includes:
- Tool descriptions as detailed documentation (not just schemas)
- Error-proofing tools (e.g., requiring absolute paths)
- Testing tool interfaces as rigorously as user interfaces

**Implication for testing:** Tool design should have its own test suite — testing that tool descriptions are clear, that error messages are actionable, and that edge cases are handled.

### 12.3 Trend: Evaluator-Optimizer Pattern

The pattern our `eval.ts` implements — using LLM judges to evaluate work and trigger refinement loops — is becoming standard in production agents. Anthropic calls this the "evaluator-optimizer workflow."

**Industry evolution of this pattern:**
1. **Single judge** (early 2024): One LLM grades the work
2. **Multi-judge panel** (late 2024): Multiple perspectives, majority voting (our current approach)
3. **Specialized domain judges** (2025): Judges trained or prompted for specific domains
4. **Execution-verified judges** (2025–2026): Judges that can run code and check results
5. **Continuous calibration** (2026): Judge accuracy tracked and calibrated over time

### 12.4 Trend: Open-Source vs. Closed Scaffold Transparency

The SWE-bench leaderboard now distinguishes between **open scaffold** submissions and closed ones. This transparency enables:
- The community to verify claims
- Researchers to reproduce results
- Fair comparison across submissions

### 12.5 Trend: Multi-Modal Agent Evaluation

Agents increasingly handle images, diagrams, and visual interfaces. New benchmarks (SWE-bench Multimodal, VisualWebArena) are emerging to evaluate these capabilities, but evaluation tooling lags behind text-only evaluation.

### 12.6 Trend: Real-World Eval Over Synthetic Benchmarks

Growing recognition that synthetic benchmarks can overstate or misrepresent real-world performance:
- Teams building **internal evaluation suites** from their actual production tasks
- A/B testing on real users becoming more common
- "Vibe-based evaluation" being supplemented (not replaced) by systematic measurement

### 12.7 Trend: Cost-Aware Evaluation

As agent costs become meaningful ($0.50–$5 per task), evaluation increasingly factors in:
- Cost per successful resolution
- Token efficiency
- Time to completion
- These metrics are becoming as important as raw accuracy

---

## 13. Recommendations for This Project

Based on this research, here are specific recommendations for our codingagent project:

### 13.1 Build a Three-Tier Evaluation Suite

#### Tier 1: Deterministic Tests (Every Commit)
Create unit tests for:
- [ ] Tool schemas and input validation
- [ ] System prompt assembly
- [ ] Context window management and compaction
- [ ] Error handling and retry logic
- [ ] Session management
- [ ] Message formatting

#### Tier 2: Smoke Tests with LLM-as-Judge (Every PR)
Create 20–30 representative tasks spanning:
- [ ] File reading and explanation
- [ ] Code search (Grep/Glob)
- [ ] File creation and editing
- [ ] Multi-step tasks (read → modify → verify)
- [ ] Error recovery scenarios
- [ ] Sub-agent delegation (Task tool)

Use our existing `eval.ts` judges to grade completions.

#### Tier 3: Full Evaluation Suite (Nightly/Weekly)
- [ ] 100+ tasks covering full capability surface
- [ ] Comparison against previous baseline
- [ ] Regression alerting
- [ ] Per-tool-category breakdown

### 13.2 Enhance the Existing Eval System

Our `eval.ts` is well-designed but could be extended:

- [ ] **Add trajectory metrics:** Track tool call count, token usage, time, recovery events alongside judge verdicts
- [ ] **Add execution-based verification:** For coding tasks, actually run/compile the code
- [ ] **Calibrate judges against human labels:** Build a labeled dataset and measure judge agreement
- [ ] **Track judge confidence over time:** Are the judges getting better or drifting?
- [ ] **Add cost tracking per eval run:** Connect evaluation to cost monitoring

### 13.3 Implement Model-Scaffold Isolation

- [ ] **Pin model versions** in all eval configurations (already using `config.smallModel`, but ensure main model is also pinned)
- [ ] **Cross-model regression matrix:** Run the same test suite against 2–3 model versions with each scaffold change
- [ ] **Maintain a "scaffold-only" changelog:** Document every scaffold change with its model-controlled evaluation results
- [ ] **Create model-capability-specific tests:** Tests that measure raw model ability (single-turn, no tools) to track model-level changes

### 13.4 Implement Cost-Effective CI/CD Integration

```
┌──────────────────────────────────────────────────┐
│  Pre-commit: Lint + deterministic unit tests     │   $0, <30s
├──────────────────────────────────────────────────┤
│  PR: Smoke tests (5 tasks × LLM-as-judge)        │   <$5, <5min
├──────────────────────────────────────────────────┤
│  Nightly: Full eval suite (100+ tasks)            │   <$100, <1hr
├──────────────────────────────────────────────────┤
│  Weekly: Cross-model matrix evaluation            │   <$500, <4hrs
├──────────────────────────────────────────────────┤
│  On model upgrade: Full A/B comparison            │   <$1000, <8hrs
└──────────────────────────────────────────────────┘
```

### 13.5 Build a Living Test Suite

- [ ] **Curate from production:** When real users encounter issues, add them as test cases
- [ ] **Use LLMs to generate test cases:** Synthetically generate edge cases
- [ ] **Stratify by difficulty:** Tag tasks as easy/medium/hard to track progress at each level
- [ ] **Refresh regularly:** Retire stale tests, add new ones representing emerging failure modes

### 13.6 Create an Attribution Log

For every change that affects agent performance:

```markdown
## [DATE] Change Description
- **Category:** Model / Scaffold / Tool / Prompt
- **Baseline:** v1.2.3 with claude-sonnet-4-20250514, resolve rate 45.2%
- **After:** v1.2.4 with same model, resolve rate 47.8%
- **Delta:** +2.6% (95% CI: +0.8% to +4.4%)
- **Cost impact:** -12% tokens per task
- **Cross-model verification:** Also tested with GPT-4o: +1.9% improvement
- **Conclusion:** Scaffold improvement (confirmed by cross-model positive signal)
```

---

## 14. References & Further Reading

### Research Papers
1. Jimenez, C. E. et al. (2023). **"SWE-bench: Can Language Models Resolve Real-World GitHub Issues?"** arXiv:2310.06770. ICLR 2024.
2. Xia, C. S. et al. (2024). **"Agentless: Demystifying LLM-based Software Engineering Agents."** arXiv:2407.01489.
3. Liu, X. et al. (2023). **"AgentBench: Evaluating LLMs as Agents."** arXiv:2308.03688. ICLR 2024.

### Industry Resources
4. Anthropic. (2024). **"Building Effective Agents."** anthropic.com/engineering/building-effective-agents
5. Anthropic. (2025). **"Raising the Bar on SWE-bench Verified with Claude 3.5 Sonnet."** anthropic.com/engineering/swe-bench-sonnet
6. OpenAI. (2024). **"Introducing SWE-bench Verified."** openai.com/index/introducing-swe-bench-verified
7. Husain, H. (2024). **"Your AI Product Needs Evals."** hamel.dev/blog/posts/evals

### Tools & Platforms
8. **Braintrust** — braintrust.dev — Evaluation and observability platform
9. **promptfoo** — promptfoo.dev — Open-source LLM evaluation CLI
10. **LangSmith** — smith.langchain.com — Trace logging and evaluation
11. **Arize Phoenix** — phoenix.arize.com — Open-source LLM observability

### Benchmarks
12. **SWE-bench Leaderboard** — swebench.com
13. **LMSYS Chatbot Arena** — chat.lmsys.org
14. **HumanEval / EvalPlus** — github.com/openai/human-eval

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| **Scaffold** | The application code surrounding an LLM — prompts, tools, routing, error handling, context management |
| **Agent** | An LLM + scaffold system that can autonomously use tools and make decisions |
| **Ablation** | Systematically removing/changing one component to measure its contribution |
| **pass@k** | Probability that at least one of k attempts solves the problem |
| **LLM-as-Judge** | Using an LLM to evaluate another LLM's output |
| **Trajectory** | The sequence of actions an agent takes to complete a task |
| **Resolve rate** | Percentage of tasks where the agent's solution passes all tests |
| **Contamination** | When benchmark tasks appear in a model's training data |
| **ELO rating** | A ranking system based on head-to-head comparisons (from chess) |
| **ACI** | Agent-Computer Interface — how tools are presented to the agent |

## Appendix B: Our Eval System Architecture

Our existing `eval.ts` implements a solid foundation:

```
┌─────────────────────────────────────────────────────────┐
│                    evaluateWork()                         │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Correctness  │  │ Completeness │  │    Goal      │   │
│  │   Judge      │  │    Judge     │  │  Alignment   │   │
│  │              │  │              │  │   Judge      │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                 │             │
│         └────────────┬────┘─────────────────┘             │
│                      │                                    │
│              Majority Voting (2/3)                         │
│                      │                                    │
│         ┌────────────┴───────────┐                        │
│         │ Pass → Done            │                        │
│         │ Fail → Refinement loop │ (max 3 rounds)         │
│         └────────────────────────┘                        │
└─────────────────────────────────────────────────────────┘
```

**Strengths of current design:**
- Multi-judge panel with majority voting (industry best practice)
- Parallel judge execution (latency optimization)
- Structured JSON output from judges
- Failed judge gracefully handled (treated as "incomplete")
- Max refinement rounds to prevent infinite loops
- Uses cheaper model for judging (cost-conscious)

**Recommended enhancements:**
1. Add trajectory metrics collection alongside judge verdicts
2. Add execution-based verification (compile/run code)
3. Build calibration pipeline against human labels
4. Add per-judge accuracy tracking over time
5. Create specialized judges for different task types (coding, writing, research)
6. Add cost and latency metrics to eval results

---

*This report was compiled from primary sources including academic papers (SWE-bench, AgentBench, Agentless), industry blog posts (Anthropic, OpenAI), practitioner guides (Hamel Husain), and tool documentation (Braintrust, promptfoo). It reflects the state of the art as of February 2026.*
