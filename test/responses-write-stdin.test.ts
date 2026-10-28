import { expect, test } from "bun:test";
import { responsesToolsetToDevin, responsesInputToOpenAIMessages, historicalToolsAsInertText, WRITE_STDIN_DEVIN_DESCRIPTION } from "../src/convert.ts";

const schema = { type: "object", properties: { session_id: { type: "number" }, chars: { type: "string" }, yield_time_ms: { type: "number" }, max_output_tokens: { type: "number" } }, required: ["session_id"], additionalProperties: false };
const declaration = { type: "function", name: "write_stdin", description: "Synthetic original client description", parameters: schema, strict: false };

test("write_stdin normalizes only Devin description and retains exact schema, identity and strict flag", () => {
  const result = responsesToolsetToDevin([declaration]);
  expect(result.tools).toEqual([{ name: "write_stdin", description: WRITE_STDIN_DEVIN_DESCRIPTION, jsonSchemaString: JSON.stringify(schema), strict: false }]);
  expect(result.identities.get("write_stdin")).toEqual({ name: "write_stdin" });
  expect(declaration.description).toBe("Synthetic original client description");
  expect(responsesToolsetToDevin([{ ...declaration, strict: true }]).tools[0].strict).toBe(true);
});

test("additional_tools duplicates use original declarations for conflict detection", () => {
  const additional = { type: "additional_tools", tools: [declaration] };
  expect(responsesToolsetToDevin([declaration, additional]).tools).toHaveLength(1);
  expect(() => responsesToolsetToDevin([declaration, { ...additional, tools: [{ ...declaration, description: "Conflicting source" }] }])).toThrow("Duplicate");
  const namespaced = responsesToolsetToDevin([{ type: "namespace", name: "mcp__other", tools: [declaration] }]);
  expect(namespaced.tools[0].description).toBe(declaration.description);
});

test("write_stdin historical calls and results remain structured with original IDs and inputs", () => {
  const tools = responsesToolsetToDevin([declaration]);
  const messages = responsesInputToOpenAIMessages([
    { type: "function_call", name: "write_stdin", call_id: "exact-stdin-id", arguments: '{"session_id":812,"chars":"synthetic\\n"}' },
    { type: "function_call_output", call_id: "exact-stdin-id", output: "Synthetic terminal output" },
  ]);
  const converted = historicalToolsAsInertText(messages, tools.identities);
  expect(converted).toEqual(messages);
  expect(converted[0].tool_calls?.[0]).toMatchObject({ id: "exact-stdin-id", function: { name: "write_stdin", arguments: '{"session_id":812,"chars":"synthetic\\n"}' } });
  expect(converted[1]).toMatchObject({ role: "tool", tool_call_id: "exact-stdin-id", content: "Synthetic terminal output" });
});
