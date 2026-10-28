import { expect, test } from "bun:test";
import { withHistoricalToolGuidance } from "../src/responses-history-guidance.ts";
import { withResponsesBridgeInstructions } from "../src/responses-bridge-capability.ts";
import { collapseSystemPromptIntoLatestUserMessage } from "../src/responses-system-collapse.ts";
import { ChatMessageSource } from "../src/proto.ts";
import type { OpenAIMessage } from "../src/convert.ts";

const history: OpenAIMessage[] = [
  { role: "assistant", tool_calls: [{ id: "prior", type: "function", function: { name: "exec", arguments: '{"input":"synthetic"}' } }] },
  { role: "tool", tool_call_id: "prior", content: "Synthetic result" },
];

test("foreign history gets current-capability guidance without changing any history", () => {
  const before = structuredClone(history);
  const tools = new Map([["exec_command", { name: "exec_command" }]]);
  const result = withHistoricalToolGuidance("Native instructions", history, tools);
  expect(result.startsWith("Native instructions\n\n")).toBe(true);
  expect(result).toContain("records of previous actions only");
  expect(result).toContain("Invoke only tool names declared in the current request");
  expect(result).toContain("currently declared shell execution tool is exec_command");
  expect(history).toEqual(before);
  expect([...tools.keys()]).toEqual(["exec_command"]);
});

test("no shell capability is advertised when exec_command is absent", () => {
  const result = withHistoricalToolGuidance("", history, new Map());
  expect(result).toContain("[Gateway current tool capabilities]");
  expect(result).not.toContain("exec_command");
});

test("requests without foreign historical tool names are byte-for-byte unchanged", () => {
  for (const messages of [[], [{ role: "user", content: "Task" }], history] as OpenAIMessage[][]) {
    expect(withHistoricalToolGuidance("Anchor\n", messages, new Map([["exec", { name: "exec" }]]))).toBe("Anchor\n");
  }
});

test("guidance follows long native/SWE/bridge instructions within the existing collapse contract", () => {
  const native = "Synthetic long native instructions.\n".repeat(5000);
  const existing = withResponsesBridgeInstructions(native, "swe-2-high");
  const composed = withHistoricalToolGuidance(existing, history, new Map());
  expect(composed.slice(0, existing.length)).toBe(existing);
  expect(composed.indexOf("[Gateway current tool capabilities]")).toBeGreaterThan(existing.length);
  const prompts = [{ messageId: "synthetic", source: ChatMessageSource.USER, prompt: "Exact user task\n" }];
  const before = structuredClone(prompts);
  const collapsed = collapseSystemPromptIntoLatestUserMessage(composed, prompts);
  expect(collapsed.systemPrompt).toBe("");
  expect(collapsed.collapsedUserPayload).toBe(`<system>\n${composed}\n</system>\n\nExact user task\n`);
  expect(prompts).toEqual(before);
});
