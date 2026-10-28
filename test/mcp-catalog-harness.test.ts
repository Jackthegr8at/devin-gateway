import { expect, test } from "bun:test";
import { RunBudget, checkResponseEvent, classify, cliArgs, catalogIdentityHash, writeStdinDiagnosticBody, requestCatalog } from "../scripts/mcp-catalog-harness.ts";
import { MEMORY_TOOL_NAMES } from "../src/responses-diagnostic-catalog.ts";

test("write_stdin declaration experiments retain exactly Memory plus one declaration and change one property", () => {
  const parameters = { type: "object", properties: { session_id: { type: "integer" }, chars: { type: "string" } }, required: ["session_id"] };
  const memory = { type: "namespace", name: "mcp__memory", tools: MEMORY_TOOL_NAMES.map(name => ({ type: "function", name, parameters: { type: "object" } })) };
  const stdin = { type: "function", name: "write_stdin", description: "Synthetic original description", parameters, strict: false };
  const body = { tools: [memory, stdin, { ...stdin, name: "unrelated" }], input: [{ type: "additional_tools", tools: [memory, stdin] }] };
  const original = writeStdinDiagnosticBody(body, "original");
  for (const variant of ["description", "name"] as const) {
    const changed = writeStdinDiagnosticBody(body, variant);
    expect(requestCatalog(changed).tools).toHaveLength(7);
    const before = original.tools.find(t => t.type === "function");
    const after = changed.tools.find(t => t.type === "function");
    expect(after.parameters).toEqual(parameters);
    expect(after.strict).toBe(false);
    expect(Object.keys(after).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))).toEqual([variant]);
    expect(requestCatalog(changed).tools.filter(t => t.name !== after.name)).toEqual(requestCatalog(original).tools.filter(t => t.name !== before.name));
  }
  expect(body.tools[1]).toEqual(stdin);
});

test("catalog identity verification is order-independent and preserves namespace distinctions", () => {
  const entries: Array<[string, { name: string; namespace?: string }]> = [["one", { namespace: "mcp__memory", name: "recall_memory" }], ["two", { name: "view_image" }]];
  expect(catalogIdentityHash(new Map(entries))).toBe(catalogIdentityHash(new Map([...entries].reverse())));
  expect(catalogIdentityHash(new Map(entries))).not.toBe(catalogIdentityHash(new Map([["one", { name: "recall_memory" }], entries[1]])));
});

test("harness budget and flags are bounded without approval or sandbox bypass", () => {
  for (const value of [0, 13, 1.5]) expect(() => new RunBudget(value)).toThrow();
  const budget = new RunBudget(2); budget.take(); budget.take(); expect(() => budget.take()).toThrow();
  const args = cliArgs("http://127.0.0.1:1234", "synthetic", { id: "x", selection: "memory-only", apps: false });
  expect(args).toContain("--ephemeral"); expect(args).toContain("--json"); expect(args).toContain("read-only");
  expect(args).toContain("mcp_servers.memory.required=true");
  expect(args).not.toContain("mcp_optional_startup_grace_ms=10000");
  expect(args).toContain("apps"); expect(args.join(" ")).not.toContain("bypass");
  expect(args.join(" ")).not.toContain("approval_policy=never");
});

test("stream safety gate permits only inert items and read-only Memory recall", () => {
  checkResponseEvent({ item: { type: "function_call", namespace: "mcp__memory", name: "recall_memory" } });
  checkResponseEvent({ item: { type: "function_call", name: "mcp__memory__recall_memory" } });
  checkResponseEvent({ item: { type: "message" } });
  for (const item of [
    { type: "function_call", namespace: "mcp__memory", name: "store_memory" },
    { type: "function_call", name: "exec_command" }, { type: "custom_tool_call", name: "exec" },
    { type: "computer_call" }, { type: "function_call", namespace: "other", name: "recall_memory" },
  ]) expect(() => checkResponseEvent({ item })).toThrow("unsafe_tool_attempt");
  expect(() => checkResponseEvent({ response: { output: [{ type: "function_call", name: "exec_command" }] } })).toThrow();
  const ids = new Set<string>();
  const item = { type: "function_call", namespace: "mcp__memory", name: "recall_memory", call_id: "synthetic-one" };
  checkResponseEvent({ item }, ids);
  checkResponseEvent({ response: { output: [item] } }, ids);
  expect(() => checkResponseEvent({ item: { ...item, call_id: "synthetic-two" } }, ids)).toThrow("recall_limit");
});

test("HTTP 200 and text completion alone never count as a successful MCP round trip", () => {
  const record = { request_id: "synthetic", tool_count: 6, responses_terminal_status: "completed" };
  expect(classify([record], false, true, 0)).toBe("no_mcp_completion");
  expect(classify([{ ...record, responses_tool_call_emitted_count: 1 }, { ...record, had_function_call_output: true }], true, true, 0)).toBe("success");
  expect(classify([{ ...record, connect_error_code: "permission_denied" }], false, false, 1)).toBe("permission_denied");
  expect(classify([], true, true, 0)).toBe("uncorrelated");
  expect(classify([record], true, false, 1)).toBe("cli_incomplete");
});
