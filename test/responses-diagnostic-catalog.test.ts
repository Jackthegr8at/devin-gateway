import { expect, test } from "bun:test";
import { responsesToolsetToDevin, historicalToolsAsInertText, responsesInputToOpenAIMessages } from "../src/convert.ts";
import { MEMORY_TOOL_NAMES, selectDiagnosticCatalog } from "../src/responses-diagnostic-catalog.ts";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schema = { type: "object", properties: { query: { type: "string" } } };
const memory = { type: "namespace", name: "mcp__memory", tools: MEMORY_TOOL_NAMES.map(name => ({ type: "function", name, parameters: schema, strict: true })) };
const extra = { type: "function", name: "unrelated", parameters: schema };

test("request opt-in selects only six Memory tools after merging declarations without mutating them", () => {
  for (const shell of [false, true]) {
    const full = responsesToolsetToDevin([memory, { type: "additional_tools", tools: [memory, extra] }, ...(shell ? [{ ...extra, name: "exec_command" }] : [])]);
    const snapshot = JSON.stringify(full.tools);
    expect(selectDiagnosticCatalog(full, null)).toBe(full);
    const selected = selectDiagnosticCatalog(full, "memory-only");
    expect(selected.tools).toHaveLength(6);
    for (const tool of selected.tools) {
      expect(tool).toBe(full.tools.find(t => t.name === tool.name));
      expect(selected.identities.get(tool.name)).toEqual(full.identities.get(tool.name));
    }
    expect(JSON.stringify(full.tools)).toBe(snapshot);
    expect(selectDiagnosticCatalog(full, null).tools).toHaveLength(shell ? 8 : 7);
  }
});

test("flat Memory identities are preserved; missing, ambiguous and unknown selections fail explicitly", () => {
  const flat = responsesToolsetToDevin(MEMORY_TOOL_NAMES.map(name => ({ ...extra, name: `mcp__memory__${name}` })));
  expect(selectDiagnosticCatalog(flat, "memory-only").tools).toEqual(flat.tools);
  expect(() => selectDiagnosticCatalog(flat, "other")).toThrow("Unsupported");
  expect(() => selectDiagnosticCatalog(responsesToolsetToDevin([extra]), "memory-only")).toThrow("all six");
  expect(() => selectDiagnosticCatalog(responsesToolsetToDevin([memory, { ...extra, name: "mcp__memory__recall_memory" }]), "memory-only")).toThrow("unambiguous");
  expect(() => responsesToolsetToDevin([memory, { type: "computer" }])).toThrow("Unsupported Responses");
});

test("group and range selection is deterministic and preserves original tool objects", () => {
  const declarations = [memory, extra, { ...extra, name: "exec_command" }, { type: "namespace", name: "mcp__other", tools: ["z", "a", "b"].map(name => ({ ...extra, name })) }];
  const full = responsesToolsetToDevin(declarations);
  for (const selection of ["memory+group:ns.mcp__other", "memory+group:ns.mcp__other@0-1", "memory+group:native", "memory+range:0-2"]) {
    const selected = selectDiagnosticCatalog(full, selection);
    const reversed = selectDiagnosticCatalog(responsesToolsetToDevin([...declarations].reverse()), selection);
    expect([...selected.identities].sort()).toEqual([...reversed.identities].sort());
    for (const tool of selected.tools) expect(tool).toBe(full.tools.find(t => t.name === tool.name));
    expect(selected.tools.length).toBeGreaterThan(6);
  }
  const names = [...selectDiagnosticCatalog(full, "memory+group:ns.mcp__other@0-1").identities.values()].filter(i => i.namespace === "mcp__other").map(i => i.name);
  expect(names).toEqual(["a", "b"]);
  for (const selection of ["memory+range:3-2", "memory+range:0-1000", "memory+group:ns.absent", "memory+group:ns.mcp__other@0-999", "memory+group:bad\nname"]) expect(() => selectDiagnosticCatalog(full, selection)).toThrow();
  expect(selectDiagnosticCatalog(full, null)).toBe(full);
});

test("excluded historical tools remain inert with exact input/result and call association", () => {
  const selected = selectDiagnosticCatalog(responsesToolsetToDevin([memory, extra]), "memory-only");
  const messages = responsesInputToOpenAIMessages([
    { type: "function_call", name: "unrelated", call_id: "exact-id", arguments: '{"query":"synthetic"}' },
    { type: "function_call_output", call_id: "exact-id", output: "Synthetic result" },
  ]);
  const inert = historicalToolsAsInertText(messages, selected.identities);
  expect(inert).toHaveLength(2);
  expect(inert[0].content).toContain('"call_id":"exact-id"');
  expect(inert[0].content).toContain('"name":"unrelated"');
  expect(inert[1].content).toContain("Synthetic result");
  expect(inert.every(m => !m.tool_calls)).toBe(true);
});

test("safe diagnostics distinguish original catalog size from the exact selected catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-isolation-"));
  try {
    const full = responsesToolsetToDevin([memory, extra]);
    const selected = selectDiagnosticCatalog(full, "memory-only");
    const path = join(dir, "safe.jsonl");
    const diagnostic = new ResponsesSafeDiagnostic("synthetic-isolation", Date.now(), path);
    diagnostic.recordCatalogSelection(full.tools.length);
    diagnostic.setRequestSummary({ tools: selected.tools.map(tool => ({ ...tool, originalName: selected.identities.get(tool.name)!.name })) });
    diagnostic.finalize();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ diagnostic_tool_catalog: "memory-only", original_tool_count: 7, tool_count: 6, tool_catalog_truncated: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
