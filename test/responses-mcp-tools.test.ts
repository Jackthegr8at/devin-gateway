import { expect, test } from "bun:test";
import { responsesToolsetToDevin, responsesInputToOpenAIMessages, historicalToolsAsInertText, ResponsesInputError } from "../src/convert.ts";
import { withHistoricalToolGuidance } from "../src/responses-history-guidance.ts";

const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const namespace = (name: string, toolName = "recall_memory") => ({ type: "namespace", name,
  tools: [{ type: "function", name: toolName, description: "Synthetic memory lookup", parameters: schema, strict: true }] });

test("MCP namespace functions preserve schema and exact inverse identity with stable collision-safe names", () => {
  const declarations = [namespace("mcp__memory"), namespace("mcp__other"), namespace("mcp__a__b", "c"), namespace("mcp__a", "b__c"),
    { type: "function", name: "multi_agent_v1__spawn_agent", parameters: schema },
    { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent", parameters: schema }] }];
  const result = responsesToolsetToDevin(declarations);
  expect(new Set(result.tools.map(t => t.name)).size).toBe(6);
  for (const tool of result.tools) { expect(tool.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/); expect(JSON.parse(tool.jsonSchemaString)).toEqual(schema); }
  expect(result.identities.get(result.tools[0].name)).toEqual({ namespace: "mcp__memory", name: "recall_memory" });
  expect(result.tools[0].strict).toBe(true);
  expect(result.tools[0].description).toBe("Synthetic memory lookup");
  const reversed = responsesToolsetToDevin([...declarations].reverse());
  expect(new Map(reversed.identities)).toEqual(new Map(result.identities));
});

test("MCP functions in additional_tools and flat MCP names are forwarded and deduplicated", () => {
  const group = namespace("mcp__memory");
  const result = responsesToolsetToDevin([group, { type: "additional_tools", tools: [group] },
    { type: "function", name: "mcp__memory__recall_memory", parameters: schema }]);
  expect(result.tools).toHaveLength(2);
  expect(result.identities.get("mcp__memory__recall_memory")).toEqual({ name: "mcp__memory__recall_memory" });
});

test("current MCP history maps to Devin names and retains exact call/result association", () => {
  const toolset = responsesToolsetToDevin([namespace("mcp__memory")]);
  const messages = responsesInputToOpenAIMessages([
    { type: "function_call", namespace: "mcp__memory", name: "recall_memory", call_id: "exact-call-id", arguments: '{"query":"synthetic"}' },
    { type: "function_call_output", call_id: "exact-call-id", output: "Synthetic memory result" },
  ]);
  const converted = historicalToolsAsInertText(messages, toolset.identities);
  expect(converted[0].tool_calls?.[0]).toEqual({ id: "exact-call-id", type: "function", function: { name: toolset.tools[0].name, arguments: '{"query":"synthetic"}' } });
  expect(converted[1]).toEqual(messages[1]);
  expect(withHistoricalToolGuidance("Anchor", messages, toolset.identities)).toBe("Anchor");
  expect(historicalToolsAsInertText(messages, new Map())[0].tool_calls).toBeUndefined();
});

test("unsupported live declarations and malformed MCP schemas fail explicitly", () => {
  for (const tools of [
    [namespace("mcp__memory"), { ...namespace("mcp__memory"), tools: [{ type: "function", name: "recall_memory", parameters: { type: "array" } }] }],
    [{ type: "namespace", name: "mcp__memory", tools: [{ type: "custom", name: "raw" }] }],
    [{ type: "mcp", server_url: "https://synthetic.invalid" }],
    [{ type: "function", name: "mcp__memory__recall_memory", parameters: true }],
    [{ type: "namespace", name: "mcp__memory", tools: [null] }],
    [{ type: "namespace", name: "mcp__memory" }],
  ]) expect(() => responsesToolsetToDevin(tools)).toThrow(ResponsesInputError);
});
