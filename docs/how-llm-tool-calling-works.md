# How LLM Tool Calling Actually Works — A Deep Technical Report

> **Author:** AI Engineer Skills Research  
> **Date:** 2026-02-25  
> **Scope:** Anthropic, OpenAI, and open-source (Llama, Mistral, Hermes) tool-calling internals

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Core Question](#the-core-question)
3. [Architecture Overview](#architecture-overview)
4. [What the Raw Model Actually Sees](#what-the-raw-model-actually-sees)
5. [Provider Deep Dives](#provider-deep-dives)
   - [Anthropic (Claude)](#anthropic-claude)
   - [OpenAI (GPT)](#openai-gpt)
   - [Open Source (Llama, Mistral, Hermes)](#open-source-llama-mistral-hermes)
6. [The Training / Fine-Tuning Layer](#the-training--fine-tuning-layer)
7. [Three Approaches to Tool Calling](#three-approaches-to-tool-calling)
8. [API Comparison: Anthropic vs OpenAI](#api-comparison-anthropic-vs-openai)
9. [The Full Stack](#the-full-stack)
10. [Implications for Our Codingagent](#implications-for-our-codingagent)
11. [Sources](#sources)

---

## Executive Summary

Tool calling (a.k.a. function calling) is **not** a native capability of raw language models. A raw LLM is simply a text-completion engine: text in → text out.

Tool calling is achieved through a **combination of two techniques**:

1. **Fine-tuning** — The model is trained on thousands of tool-calling examples so it learns to output structured tool calls in a specific format (XML, JSON, or special tokens).
2. **API-layer wrapping** — The API provider injects tool definitions into the model's prompt (hidden from the developer), sets stop sequences, and parses the model's raw text output into structured JSON responses.

Neither technique alone is sufficient. Prompt engineering without fine-tuning is unreliable. Fine-tuning without API-layer parsing would require every developer to write their own regex/parser.

---

## The Core Question

**Q: Is tool calling a fine-tuned model feature, or is it just a wrapper over the raw LLM that asks it to output a specific format?**

**A: It's both.** The model is fine-tuned to reliably produce structured tool-call output, AND the API layer wraps this with prompt injection + output parsing to present a clean developer interface.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Developer Application (e.g., codingagent)                      │
│  - Defines tools (Read, Write, Bash, Grep, etc.)                │
│  - Runs the agentic loop (call → execute → feed back → repeat)  │
│  - Executes tools locally and feeds results back                 │
├─────────────────────────────────────────────────────────────────┤
│  SDK (@anthropic-ai/sdk or openai)                              │
│  - HTTP client, authentication, streaming                       │
├─────────────────────────────────────────────────────────────────┤
│  API Layer (Anthropic / OpenAI servers)                          │
│  - Injects tool definitions into a hidden system prompt         │
│  - Sets stop sequences (e.g., </function_calls>)                │
│  - Parses raw model output → structured tool_use blocks         │
│  - Constrained decoding for strict/structured output mode       │
├─────────────────────────────────────────────────────────────────┤
│  Fine-tuned Instruction Model (Claude / GPT)                    │
│  - Trained on tool-calling examples with special formats        │
│  - Learned special tokens / XML / JSON conventions              │
│  - Knows WHEN to call tools vs. answer directly                 │
│  - Knows HOW to extract parameters from natural language        │
├─────────────────────────────────────────────────────────────────┤
│  Base LLM (transformer)                                         │
│  - Pure text in → text out (next-token prediction)              │
│  - No concept of "tools" — just predicts next tokens            │
└─────────────────────────────────────────────────────────────────┘
```

---

## What the Raw Model Actually Sees

Both OpenAI and Anthropic confirm that tool definitions are **injected into the prompt** and count as input tokens.

### OpenAI (official documentation)

> *"Under the hood, functions are injected into the system message in a syntax the model has been trained on. This means functions **count against the model's context limit** and are **billed as input tokens**."*

### Anthropic (official documentation)

> *"When you use `tools`, we also automatically include a **special system prompt** for the model which enables tool use."* (~346 tokens overhead for Claude 4 models)

### Example: What You Send vs. What the Model Sees

**What you send via the API:**

```json
{
  "model": "claude-sonnet-4-20250514",
  "system": "You are a coding assistant",
  "tools": [{ "name": "Read", "description": "Read a file", "input_schema": { "type": "object", "properties": { "file_path": { "type": "string" } }, "required": ["file_path"] } }],
  "messages": [{ "role": "user", "content": "read foo.ts" }]
}
```

**What the model actually receives (reconstructed):**

```xml
<system>
You are a coding assistant

In this environment you have access to a set of tools you can use
to answer the user's question.

You can invoke functions by writing a "<function_calls>" block like the following:

<function_calls>
<invoke name="$FUNCTION_NAME">
<parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</parameter>
</invoke>
</function_calls>

Here are the functions available:

<tools>
<tool>
  <name>Read</name>
  <description>Read a file</description>
  <parameters>
    <parameter name="file_path" type="string" required="true"/>
  </parameters>
</tool>
</tools>

String and scalar parameters should be specified as is, while lists
and objects should use JSON format.
</system>

<user>read foo.ts</user>
```

**What the model outputs (raw text):**

```xml
I'll read that file for you.

<function_calls>
<invoke name="Read">
<parameter name="file_path">foo.ts</parameter>
</invoke>
</function_calls>
```

**What the API returns to you (parsed):**

```json
{
  "content": [
    { "type": "text", "text": "I'll read that file for you." },
    { "type": "tool_use", "id": "toolu_abc", "name": "Read", "input": { "file_path": "foo.ts" } }
  ],
  "stop_reason": "tool_use"
}
```

The API layer **hides the XML** from you and presents clean structured JSON.

---

## Provider Deep Dives

### Anthropic (Claude)

#### Internal Format

Anthropic uses an **XML-based** format for tool calling. A leaked system prompt from January 2025 reveals the structure:

```xml
<function_calls>
<invoke name="$FUNCTION_NAME">
<parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</parameter>
</invoke>
</function_calls>
```

#### How It Works

| Aspect | Detail |
|--------|--------|
| **Injection** | Tool definitions added as a hidden system prompt (~346 tokens overhead) |
| **Output format** | XML-based `<function_calls><invoke name="...">` blocks |
| **Parsing** | Uses **regex** (not a full XML parser) to extract tool calls |
| **Stop sequence** | `</function_calls>` — model stops generating when it emits this |
| **Fine-tuning** | Model trained to recognize tool definitions and output this XML format |
| **Parallel calls** | Multiple `<invoke>` blocks within a single `<function_calls>` block |

#### API Surface

```
POST /v1/messages

Request:
  - model, system, messages[], tools[], max_tokens, stream
  
Response:
  - content[] → text blocks + tool_use blocks
  - stop_reason: "end_turn" | "tool_use" | "max_tokens"
  - usage: { input_tokens, output_tokens }

Tool call flow:
  1. Assistant returns: { type: "tool_use", id, name, input: {object} }
  2. You send back:    { role: "user", content: [{ type: "tool_result", tool_use_id, content }] }
```

#### Key Characteristics

- Tool arguments returned as a **parsed object** (not a string)
- System prompt is a **top-level field**, not in the messages array
- Tool results sent as `tool_result` content blocks in a `user` message
- No built-in structured output / constrained decoding (as of early 2026)

---

### OpenAI (GPT)

#### Internal Format

OpenAI uses a **ChatML-derived** internal format. Tool definitions are injected into the system message in a proprietary syntax the model was trained on. The exact format is not publicly documented, but it counts as input tokens.

#### How It Works

| Aspect | Detail |
|--------|--------|
| **Injection** | Tool definitions injected into system message as structured tokens |
| **Output format** | Model outputs JSON strings for tool arguments |
| **Parsing** | API parses raw output into `tool_calls` array |
| **Strict mode** | Uses **constrained decoding** (LLGuidance) to guarantee valid JSON schema |
| **Fine-tuning** | Models fine-tuned on function-calling patterns; you can also fine-tune your own |
| **Parallel calls** | Multiple tool calls in a single response (can be disabled) |

#### API Surface — Two APIs

OpenAI offers **two** API styles:

**Chat Completions API (legacy, still widely used):**

```
POST /v1/chat/completions

Request:
  - model, messages[], tools[], max_tokens, stream
  
Response:
  - choices[].message.tool_calls[] → { id, function: { name, arguments: "JSON string" } }
  - finish_reason: "stop" | "tool_calls" | "length"
  - usage: { prompt_tokens, completion_tokens }

Tool call flow:
  1. Assistant returns: { tool_calls: [{ id, function: { name, arguments: "{...}" } }] }
  2. You send back:    { role: "tool", tool_call_id, content: "result string" }
```

**Responses API (newer, 2025+):**

```
POST /v1/responses

Request:
  - model, input[], tools[], stream
  
Response:
  - output[] → function_call items with { call_id, name, arguments }
  - Custom tools with free-text input (not just JSON)
  - Context-free grammar (CFG) support via Lark/regex
```

#### Key Characteristics

- Tool arguments returned as a **JSON string** (must `JSON.parse()` yourself)
- System prompt is a `{ role: "system" }` message in the messages array
- Tool results sent as `{ role: "tool", tool_call_id, content }` messages
- **Strict mode** constrains model output to match the JSON schema exactly
- **Custom tools** can use free-text input with CFG grammar constraints
- You can **fine-tune** models on function-calling examples for better accuracy

---

### Open Source (Llama, Mistral, Hermes)

Open-source models reveal the internals most clearly because you can see the **raw tokens** — there's no API layer hiding anything.

#### Llama 3.1 (Meta)

Uses dedicated **special tokens** added to the tokenizer:

| Token | Purpose |
|-------|---------|
| `<\|begin_of_text\|>` | Start of prompt |
| `<\|start_header_id\|>` / `<\|end_header_id\|>` | Role markers |
| `<\|python_tag\|>` | Signals a tool call is starting |
| `<\|eom_id\|>` | End of message — expects tool result back (multi-step) |
| `<\|eot_id\|>` | End of turn — done, no more tool calls |

**Raw prompt format for built-in tools:**

```
<|begin_of_text|><|start_header_id|>system<|end_header_id|>

Environment: ipython
Tools: brave_search, wolfram_alpha
Cutting Knowledge Date: December 2023
Today Date: 23 July 2024

You are a helpful assistant.<|eot_id|>
<|start_header_id|>user<|end_header_id|>

What's the weather in Paris?<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>
```

**Raw model output:**

```
<|python_tag|>brave_search.call(query="current weather Paris")<|eom_id|>
```

**Tool result fed back with `ipython` role:**

```
<|start_header_id|>ipython<|end_header_id|>

{"temperature": "22C", "conditions": "sunny"}<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>
```

**JSON-based tool calling (custom tools):**

```
<|start_header_id|>user<|end_header_id|>

Given the following functions, respond with a JSON for a function call:
{"type": "function", "function": {"name": "get_weather", ...}}

Question: what is the weather?<|eot_id|>
<|start_header_id|>assistant<|end_header_id|>

{"name": "get_weather", "parameters": {"location": "Paris, France"}}<|eot_id|>
```

**User-defined custom format:**

```
<function=spotify_trending_songs>{"n": "5"}</function><|eom_id|>
```

Llama supports **three** tool-calling modes:
1. Built-in Python-style calls (`brave_search.call(...)`)
2. JSON-based zero-shot tool calling
3. User-defined custom format with `<function=name>` tags

#### Mistral

Uses its own special tokens:

```
[AVAILABLE_TOOLS][...tool JSON definitions...][/AVAILABLE_TOOLS]
[INST]What's the weather in Paris?[/INST]
[TOOL_CALLS] [{"name": "get_weather", "arguments": {"location": "Paris"}}]
```

| Token | Purpose |
|-------|---------|
| `[AVAILABLE_TOOLS]` / `[/AVAILABLE_TOOLS]` | Wraps tool definitions |
| `[TOOL_CALLS]` | Prefixes tool call output (no closing tag) |
| `[TOOL_RESULTS]` / `[/TOOL_RESULTS]` | Wraps tool results fed back |
| `[INST]` / `[/INST]` | Wraps user instructions |

**Multi-turn example:**

```
[AVAILABLE_TOOLS][{"type": "function", "function": {"name": "get_weather", ...}}][/AVAILABLE_TOOLS]
[INST]What's the weather in Paris?[/INST]
[TOOL_CALLS] [{"name": "get_weather", "arguments": {"location": "Paris", "format": "celsius"}}]</s>
[TOOL_RESULTS][{"content": "25C"}][/TOOL_RESULTS]
The current temperature in Paris is 25 degrees Celsius.
[INST]How about SF?[/INST]
[TOOL_CALLS] [{"name": "get_weather", "arguments": {"location": "San Francisco", "format": "fahrenheit"}}]
```

#### Hermes (NousResearch)

Uses XML-style tags:

```xml
<tools>...tool definitions...</tools>
<tool_call>{"name": "get_weather", "arguments": {...}}</tool_call>
<tool_response>{"temperature": "25C"}</tool_response>
```

#### Key Takeaway

> **There is no standard for tool-calling tokens across open-source models.** Every model family uses different special tokens and formats. This is why inference servers like vLLM need model-specific "tool parsers."

---

## The Training / Fine-Tuning Layer

The models don't just "figure out" tool calling from the prompt alone. They are **specifically trained** through multiple stages:

### Stage 1: Pre-training

The base model learns general language patterns, including JSON syntax, XML syntax, function signatures, and code patterns. But it has no specific concept of "calling a tool."

### Stage 2: Instruction Fine-tuning (SFT)

The model is trained on thousands of supervised examples like:

```
Input:  "What's the weather?" + [tool definitions]
Output: {"name": "get_weather", "arguments": {"location": "..."}}

Input:  [tool result: {"temp": "25C"}]
Output: "The current temperature is 25°C."
```

This teaches the model:
- **When** to call a tool (vs. answering from internal knowledge)
- **Which** tool to select from multiple options
- **How** to extract parameters from natural language
- **How** to format tool results into a natural response

### Stage 3: RLHF / DPO (Reinforcement Learning)

Further refined with preference data to:
- Choose the right tool more reliably
- Avoid hallucinating tool calls when no tool is needed
- Handle edge cases (missing parameters, ambiguous queries)

### User Fine-tuning (OpenAI)

OpenAI allows you to **fine-tune your own models** on tool-calling data:

```json
{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What's the weather in Boston?"},
    {"role": "assistant", "tool_calls": [
      {"function": {"name": "get_weather", "arguments": "{\"location\":\"Boston\"}"}}
    ]}
  ],
  "tools": [{"type": "function", "function": {"name": "get_weather", ...}}]
}
```

This is useful when:
- You have many tools (20+) and need better selection accuracy
- You want to reduce token usage (fine-tuned models need shorter descriptions)
- You need specialized parameter extraction for your domain

---

## Three Approaches to Tool Calling

| Approach | How It Works | Reliability | Used By |
|----------|-------------|-------------|---------|
| **Prompt engineering only** | Describe tools + desired output format in the prompt. Parse output with regex. No model modifications. | ⭐⭐ Unreliable | Early LangChain, ReAct, any base model |
| **Fine-tuning + special tokens** | Train model on tool-call examples with special tokens in the tokenizer. Model learns to output structured calls. | ⭐⭐⭐⭐ Good | Llama 3.1, Mistral, Hermes, Gorilla |
| **Fine-tuning + API wrapper + constrained decoding** | All of the above + API injects/parses prompts + constrained decoding guarantees valid output | ⭐⭐⭐⭐⭐ Best | OpenAI (strict mode), Anthropic |

### Prompt Engineering Only (No Fine-tuning)

The earliest approach. Works with any model but is fragile:

```
You have access to the following tools:
- get_weather(location: string): Get current weather

Use this format:
Thought: I need to check the weather
Action: get_weather
Action Input: {"location": "Paris"}

Question: What's the weather in Paris?
```

The model might output the right format, or it might not. It might add extra text, use the wrong JSON structure, or forget to call a tool entirely.

### Fine-tuning + Special Tokens (Open Source)

Much more reliable. The model's tokenizer includes special tokens that act as "signals":

```
[AVAILABLE_TOOLS] → "Here come tool definitions"
[TOOL_CALLS]      → "I'm making a tool call now"
[TOOL_RESULTS]    → "Here's what the tool returned"
```

Because these are **real tokens** (not just text), the model treats them semantically differently from regular text. The model was trained to produce them in the right context.

### API Wrapper + Constrained Decoding (Commercial)

The most reliable. On top of fine-tuning:

- **Prompt injection**: API automatically formats tool definitions into the model's expected format
- **Parsing**: API extracts structured data from the model's raw text output
- **Constrained decoding** (OpenAI strict mode): During token generation, the model is only allowed to produce tokens that form valid JSON conforming to the tool's parameter schema. This **guarantees** schema-valid output at the cost of some latency.

---

## API Comparison: Anthropic vs OpenAI

| Feature | Anthropic Messages API | OpenAI Chat Completions API |
|---------|----------------------|---------------------------|
| **Endpoint** | `POST /v1/messages` | `POST /v1/chat/completions` |
| **System prompt** | Top-level `system` field | `{ role: "system" }` in messages array |
| **Tool definition** | `{ name, description, input_schema }` | `{ type: "function", function: { name, description, parameters } }` |
| **Tool call response** | Content block: `{ type: "tool_use", id, name, input: {object} }` | Separate field: `tool_calls: [{ id, function: { name, arguments: "JSON string" } }]` |
| **Tool arguments type** | **Parsed object** | **JSON string** (must `JSON.parse()`) |
| **Tool result format** | `{ role: "user", content: [{ type: "tool_result", tool_use_id, content }] }` | `{ role: "tool", tool_call_id, content }` |
| **Stop reason** | `stop_reason: "end_turn" \| "tool_use" \| "max_tokens"` | `finish_reason: "stop" \| "tool_calls" \| "length"` |
| **Token usage** | `usage: { input_tokens, output_tokens }` | `usage: { prompt_tokens, completion_tokens }` |
| **Strict mode** | Not available | `strict: true` — constrained decoding via structured outputs |
| **Custom tools** | N/A | Free-text input + CFG grammar (Lark/regex) |
| **Fine-tuning** | Limited (AWS Bedrock) | Full support for function-calling fine-tuning |
| **Parallel calls** | Supported (multiple `invoke` blocks) | Supported (`parallel_tool_calls: true/false`) |
| **SDK** | `@anthropic-ai/sdk` | `openai` |
| **Streaming** | `content_block_start/delta/stop` events | `response.function_call_arguments.delta` events |
| **Internal format** | XML-based (`<function_calls>`) | ChatML-derived (proprietary) |
| **Parsing** | Regex-based | Proprietary |

### OpenAI's Newer Responses API (2025+)

OpenAI introduced a second, more modern API:

| Feature | Chat Completions API | Responses API |
|---------|---------------------|---------------|
| **Input field** | `messages[]` | `input[]` |
| **Output field** | `choices[].message` | `output[]` |
| **Tool call type** | `function` in `tool_calls` | `function_call` item in `output` |
| **Result type** | `{ role: "tool" }` | `{ type: "function_call_output" }` |
| **Custom tools** | Not supported | Supported with CFG grammars |
| **Reasoning items** | Not exposed | Must pass back with tool results |

---

## The Full Stack

Here is how our codingagent's tool-calling chain works end-to-end:

```
User types: "read the file gateway.ts"
        │
        ▼
┌─ codingagent (loop.ts) ────────────────────────────────────────┐
│                                                                 │
│  1. Build messages array (conversation history)                 │
│  2. Build tools array (Read, Write, Bash, Grep, etc.)           │
│  3. Call client.messages.stream({ model, system, messages,      │
│     tools, max_tokens, stream: true })                          │
│                                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP POST /v1/messages
                         ▼
┌─ Anthropic API Server ─────────────────────────────────────────┐
│                                                                 │
│  4. Inject tools into hidden system prompt (XML format)         │
│  5. Set stop sequence: </function_calls>                        │
│  6. Send full prompt to Claude model                            │
│                                                                 │
│  ┌─ Claude Model ────────────────────────────────────────────┐  │
│  │                                                            │  │
│  │  7. Model sees: system prompt + tool XML + user message    │  │
│  │  8. Model generates raw text:                              │  │
│  │     "I'll read that file.\n<function_calls>\n              │  │
│  │      <invoke name=\"Read\">\n                              │  │
│  │      <parameter name=\"file_path\">gateway.ts</parameter>  │  │
│  │      \n</invoke>\n</function_calls>"                       │  │
│  │                                                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  9. Parse raw text with regex → extract tool_use blocks         │
│  10. Return structured JSON response with content blocks        │
│                                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │ JSON response
                         ▼
┌─ codingagent (loop.ts) ────────────────────────────────────────┐
│                                                                 │
│  11. Receive: [{ type: "text", text: "I'll read..." },          │
│               { type: "tool_use", name: "Read",                 │
│                 input: { file_path: "gateway.ts" } }]           │
│  12. Execute Read("gateway.ts") → get file contents             │
│  13. Append assistant message + tool_result to messages          │
│  14. Loop back to step 3 (until stop_reason: "end_turn")        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implications for Our Codingagent

### Why Token Count Is So High

The `tokens: 1283587→4342` we saw in debug logs makes more sense now:

- **Every tool definition** is injected as text into the prompt → tokens
- **Every previous message** in the conversation (user + assistant + tool results) is re-sent → tokens
- **Every tool result** (file contents, bash output) adds to the conversation → tokens
- **Anthropic's hidden tool system prompt** adds ~346 tokens overhead per request

With 10+ tools and a long conversation history full of file contents, 1.28M input tokens is plausible but excessive. The compaction system (`compaction.ts`) exists to address this.

### Provider Portability

If we ever want to support OpenAI in addition to Anthropic, the main translation work would be:

1. **Tool definitions**: `input_schema` → `parameters` (wrapped in `function` object)
2. **Tool call parsing**: `content[].tool_use` → `tool_calls[].function` (and `JSON.parse(arguments)`)
3. **Tool results**: `{ type: "tool_result", tool_use_id }` → `{ role: "tool", tool_call_id }`
4. **System prompt**: Top-level field → `{ role: "system" }` message
5. **Stop reason**: `"tool_use"` → `"tool_calls"`

The agentic loop logic itself would remain the same.

---

## Sources

1. **OpenAI Function Calling Guide** — https://developers.openai.com/api/docs/guides/function-calling  
   *Confirms tool definitions are "injected into the system message" and billed as input tokens.*

2. **Anthropic Tool Use Documentation** — https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview  
   *Documents the ~346 token system prompt overhead and tool_use content blocks.*

3. **Anthropic Claude API Tool Use System Prompt (January 2025 leak)** — https://agentic-design.ai/prompt-hub/anthropic/claude-api-tool-use-20250119  
   *Reveals the XML-based `<function_calls><invoke>` format and regex parsing.*

4. **Meta Llama 3.1 Prompt Format** — https://www.llama.com/docs/model-cards-and-prompt-formats/llama3_1/  
   *Documents special tokens (`<|python_tag|>`, `<|eom_id|>`, `<|eot_id|>`), built-in tools, JSON-based and custom tool calling.*

5. **Function Calling with Open-Source LLMs** (Andrei Bondarev, Medium) — https://medium.com/@rushing_andrei/function-calling-with-open-source-llms-594aa5b3a304  
   *Covers Mistral special tokens (`[AVAILABLE_TOOLS]`, `[TOOL_CALLS]`), Hermes format, and raw prompt examples.*

6. **How Tool Calling Works in LLMs** (Scalable Thread newsletter) — https://newsletter.scalablethread.com/p/how-tool-calling-works-in-llms  
   *Explains the training-time vs inference-time mechanisms.*

7. **OpenAI Fine-tuning for Function Calling Cookbook** — https://developers.openai.com/cookbook/examples/fine_tuning_for_function_calling  
   *Shows how to fine-tune models on function-calling examples.*

8. **HuggingFace Agents Course: Fine-tuning LLMs for Function Calling** — https://deepwiki.com/huggingface/agents-course/4.1-fine-tuning-llms-for-function-calling  
   *Covers SFT training data format and special token integration.*

---

*This report was compiled from primary documentation (OpenAI, Anthropic, Meta), leaked system prompts, open-source model implementations, and community research.*
