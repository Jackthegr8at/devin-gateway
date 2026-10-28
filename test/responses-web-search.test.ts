import { expect, test } from "bun:test";
import { responsesToolsetToDevin, ResponsesInputError } from "../src/convert.ts";
import { withNativeWebSearchUnavailable } from "../src/responses-history-guidance.ts";

const schema = { type: "object", properties: { query: { type: "string" } } };
const memory = { type: "namespace", name: "mcp__memory", tools: [{ type: "function", name: "recall_memory", parameters: schema }] };

test("only hosted web_search is excluded while Memory and native functions remain unchanged", () => {
  const tools = [memory, { type: "function", name: "exec_command", parameters: schema }];
  const expected = responsesToolsetToDevin(tools);
  for (const declarations of [[{ type: "web_search" }, ...tools], [{ type: "additional_tools", tools: [{ type: "web_search" }, ...tools] }]]) {
    const actual = responsesToolsetToDevin(declarations);
    expect(actual.nativeWebSearchUnavailable).toBe(true);
    expect(actual.tools).toEqual(expected.tools);
    expect(actual.identities).toEqual(expected.identities);
  }
  expect(expected.nativeWebSearchUnavailable).toBeUndefined();
});

test("other unsupported native tool types still fail explicitly", () => {
  for (const type of ["web_search_preview", "computer", "mcp", "synthetic_unknown"]) {
    expect(() => responsesToolsetToDevin([{ type }, memory])).toThrow(ResponsesInputError);
  }
});

test("capability notice preserves preceding instructions and explicitly disclaims native browsing", () => {
  const result = withNativeWebSearchUnavailable("Exact native instructions\n");
  expect(result.startsWith("Exact native instructions\n\n\n")).toBe(true);
  expect(result).toContain("web_search is unavailable in this provider session");
  expect(result).toContain("do not invent a substitute");
});
