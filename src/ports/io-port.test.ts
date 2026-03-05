/**
 * Tests for the I/O port abstraction.
 *
 * Run: npx tsx src/io-port.test.ts
 *
 * These are lightweight assertion-based tests — no test framework needed.
 * They verify the core contracts of the port abstraction:
 *
 * 1. routeLoopEvent dispatches to the correct OutputPort method
 * 2. routeLoopEvent returns accumulated assistant text correctly
 * 3. BaseOutputPort provides safe no-op defaults
 * 4. MultiOutputPort broadcasts to all ports (isolation on failure)
 * 5. InputPort → OutputPort round-trip via in-memory ports
 *
 * @module io-port.test
 */

import { strict as assert } from "assert";
import type { OutputPort, InputPort, IOPort, UserMessage } from "./io-port.js";
import { BaseOutputPort, MultiOutputPort, routeLoopEvent } from "./io-port.js";
import type { LoopYield, ToolResult } from "../core/types.js";

// ── Test Helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`  ✅ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err instanceof Error ? err.message : err}`);
      failed++;
    });
}

/**
 * In-memory output port that records every method call for assertions.
 */
class RecordingOutputPort extends BaseOutputPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  onAssistantText(text: string): void { this.record("onAssistantText", text); }
  onAssistantTextComplete(fullText: string): void { this.record("onAssistantTextComplete", fullText); }
  onToolUse(toolName: string, input: Record<string, unknown>): void { this.record("onToolUse", toolName, input); }
  onToolResult(toolName: string, result: ToolResult, durationMs?: number): void { this.record("onToolResult", toolName, result, durationMs); }
  onTurnComplete(stopReason: string): void { this.record("onTurnComplete", stopReason); }
  onError(error: string): void { this.record("onError", error); }
  onApiCallStart(): void { this.record("onApiCallStart"); }
  onApiCallEnd(durationMs: number, usage?: { inputTokens: number; outputTokens: number }): void { this.record("onApiCallEnd", durationMs, usage); }
  onEvalStart(round: number, judgeCount: number): void { this.record("onEvalStart", round, judgeCount); }
  onEvalJudgeVerdict(v: { judgeName: string; isComplete: boolean; reasoning: string }, round: number): void { this.record("onEvalJudgeVerdict", v, round); }
  onEvalComplete(passed: boolean, round: number, prompt?: string): void { this.record("onEvalComplete", passed, round, prompt); }
  info(message: string): void { this.record("info", message); }
  warn(message: string): void { this.record("warn", message); }
  success(label: string, detail?: string): void { this.record("success", label, detail); }
}

/**
 * In-memory input port that yields pre-defined messages.
 */
class MockInputPort implements InputPort {
  constructor(private readonly msgs: UserMessage[]) {}

  async *messages(): AsyncIterable<UserMessage> {
    for (const msg of this.msgs) {
      yield msg;
    }
  }

  async close(): Promise<void> {}
}

/**
 * Failing output port — throws on every method. Used to test
 * MultiOutputPort's error isolation.
 */
class FailingOutputPort extends BaseOutputPort {
  onAssistantText(_text: string): void { throw new Error("boom"); }
  onToolUse(_name: string, _input: Record<string, unknown>): void { throw new Error("boom"); }
  onTurnComplete(_reason: string): void { throw new Error("boom"); }
  info(_msg: string): void { throw new Error("boom"); }
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🧪 I/O Port Tests\n");

  // ── routeLoopEvent ──

  await test("routeLoopEvent: assistant_text accumulates and returns text", async () => {
    const port = new RecordingOutputPort();
    const event: LoopYield = { type: "assistant_text", text: "hello " };
    const result = await routeLoopEvent(event, port, "");
    assert.equal(result, "hello ");
    assert.equal(port.calls.length, 1);
    assert.equal(port.calls[0].method, "onAssistantText");
    assert.equal(port.calls[0].args[0], "hello ");

    // Second chunk
    const result2 = await routeLoopEvent({ type: "assistant_text", text: "world" }, port, result);
    assert.equal(result2, "hello world");
  });

  await test("routeLoopEvent: tool_use flushes accumulated text", async () => {
    const port = new RecordingOutputPort();
    const result = await routeLoopEvent(
      { type: "tool_use", toolName: "Read", input: { file_path: "x" } },
      port,
      "some text"
    );
    assert.equal(result, ""); // text was flushed
    assert.equal(port.calls[0].method, "onAssistantTextComplete");
    assert.equal(port.calls[0].args[0], "some text");
    assert.equal(port.calls[1].method, "onToolUse");
  });

  await test("routeLoopEvent: tool_use with no accumulated text skips flush", async () => {
    const port = new RecordingOutputPort();
    await routeLoopEvent(
      { type: "tool_use", toolName: "Read", input: {} },
      port,
      ""
    );
    assert.equal(port.calls.length, 1);
    assert.equal(port.calls[0].method, "onToolUse");
  });

  await test("routeLoopEvent: turn_complete flushes text and resets", async () => {
    const port = new RecordingOutputPort();
    const result = await routeLoopEvent(
      { type: "turn_complete", stopReason: "end_turn" },
      port,
      "final text"
    );
    assert.equal(result, ""); // reset after turn
    assert.equal(port.calls[0].method, "onAssistantTextComplete");
    assert.equal(port.calls[0].args[0], "final text");
    assert.equal(port.calls[1].method, "onTurnComplete");
  });

  await test("routeLoopEvent: error is dispatched", async () => {
    const port = new RecordingOutputPort();
    const result = await routeLoopEvent({ type: "error", error: "something broke" }, port, "acc");
    assert.equal(result, "acc"); // accumulated text preserved
    assert.equal(port.calls[0].method, "onError");
    assert.equal(port.calls[0].args[0], "something broke");
  });

  await test("routeLoopEvent: all event types are dispatched", async () => {
    const port = new RecordingOutputPort();
    const events: LoopYield[] = [
      { type: "api_call_start" },
      { type: "api_call_end", durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "assistant_text", text: "hi" },
      { type: "tool_use", toolName: "Bash", input: { command: "ls" } },
      { type: "tool_result", toolName: "Bash", result: { content: "file.ts" }, durationMs: 50 },
      { type: "turn_complete", stopReason: "end_turn" },
      { type: "error", error: "oops" },
      { type: "eval_start", round: 1, judgeCount: 3 },
      { type: "eval_judge_verdict", verdict: { judgeName: "correct", isComplete: true, reasoning: "ok" }, round: 1 },
      { type: "eval_complete", passed: true, round: 1 },
    ];

    let text = "";
    for (const event of events) {
      text = await routeLoopEvent(event, port, text);
    }

    const methods = port.calls.map((c) => c.method);
    assert.ok(methods.includes("onApiCallStart"));
    assert.ok(methods.includes("onApiCallEnd"));
    assert.ok(methods.includes("onAssistantText"));
    assert.ok(methods.includes("onToolUse"));
    assert.ok(methods.includes("onToolResult"));
    assert.ok(methods.includes("onTurnComplete"));
    assert.ok(methods.includes("onError"));
    assert.ok(methods.includes("onEvalStart"));
    assert.ok(methods.includes("onEvalJudgeVerdict"));
    assert.ok(methods.includes("onEvalComplete"));
  });

  // ── BaseOutputPort ──

  await test("BaseOutputPort: all methods are safe no-ops", async () => {
    // This would throw if any method was undefined
    const port = new (class extends BaseOutputPort {})();
    port.onAssistantText("x");
    port.onAssistantTextComplete("x");
    port.onToolUse("T", {});
    port.onToolResult("T", { content: "ok" });
    port.onTurnComplete("end_turn");
    port.onError("e");
    port.onApiCallStart();
    port.onApiCallEnd(100);
    port.onEvalStart(1, 3);
    port.onEvalJudgeVerdict({ judgeName: "j", isComplete: true, reasoning: "r" }, 1);
    port.onEvalComplete(true, 1);
    port.info("i");
    port.warn("w");
    port.success("s");
    await port.close();
    // If we get here, all no-ops worked
    assert.ok(true);
  });

  // ── MultiOutputPort ──

  await test("MultiOutputPort: broadcasts to all ports", async () => {
    const p1 = new RecordingOutputPort();
    const p2 = new RecordingOutputPort();
    const multi = new MultiOutputPort(p1, p2);

    await multi.onAssistantText("hello");
    assert.equal(p1.calls.length, 1);
    assert.equal(p2.calls.length, 1);
    assert.equal(p1.calls[0].args[0], "hello");
    assert.equal(p2.calls[0].args[0], "hello");
  });

  await test("MultiOutputPort: one port failure doesn't break others", async () => {
    const good = new RecordingOutputPort();
    const bad = new FailingOutputPort();
    const multi = new MultiOutputPort(bad, good); // bad is first

    // Suppress console.error for this test
    const origError = console.error;
    console.error = () => {};

    await multi.onAssistantText("hi");

    console.error = origError;

    // good port should still have received the call
    assert.equal(good.calls.length, 1);
    assert.equal(good.calls[0].args[0], "hi");
  });

  await test("MultiOutputPort: addPort/removePort work", async () => {
    const p1 = new RecordingOutputPort();
    const p2 = new RecordingOutputPort();
    const multi = new MultiOutputPort(p1);

    multi.addPort(p2);
    await multi.info("test");
    assert.equal(p1.calls.length, 1);
    assert.equal(p2.calls.length, 1);

    const removed = multi.removePort(p2);
    assert.ok(removed);
    await multi.warn("warn");
    assert.equal(p1.calls.length, 2);
    assert.equal(p2.calls.length, 1); // p2 didn't get the warn
  });

  // ── InputPort/IOPort contract ──

  await test("MockInputPort: yields all messages then completes", async () => {
    const input = new MockInputPort([
      { text: "hello" },
      { text: "world", metadata: { chatId: 123 } },
    ]);

    const received: UserMessage[] = [];
    for await (const msg of input.messages()) {
      received.push(msg);
    }

    assert.equal(received.length, 2);
    assert.equal(received[0].text, "hello");
    assert.equal(received[1].text, "world");
    assert.equal(received[1].metadata?.chatId, 123);
  });

  await test("Full round-trip: InputPort → routeLoopEvent → OutputPort", async () => {
    const input = new MockInputPort([{ text: "test prompt" }]);
    const output = new RecordingOutputPort();

    // Simulate what session runner does (simplified)
    for await (const msg of input.messages()) {
      assert.equal(msg.text, "test prompt");

      // Simulate agentic loop events
      const events: LoopYield[] = [
        { type: "api_call_start" },
        { type: "api_call_end", durationMs: 200, usage: { inputTokens: 100, outputTokens: 50 } },
        { type: "assistant_text", text: "The answer is " },
        { type: "assistant_text", text: "42." },
        { type: "turn_complete", stopReason: "end_turn" },
      ];

      let text = "";
      for (const event of events) {
        text = await routeLoopEvent(event, output, text);
      }
    }

    const methods = output.calls.map((c) => c.method);
    assert.deepEqual(methods, [
      "onApiCallStart",
      "onApiCallEnd",
      "onAssistantText",     // "The answer is "
      "onAssistantText",     // "42."
      "onAssistantTextComplete", // "The answer is 42." (flushed by turn_complete)
      "onTurnComplete",
    ]);

    // Verify the flushed complete text
    const completeCall = output.calls.find((c) => c.method === "onAssistantTextComplete");
    assert.equal(completeCall?.args[0], "The answer is 42.");
  });

  // ── Summary ──

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
