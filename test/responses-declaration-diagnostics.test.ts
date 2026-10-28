import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesToolsetToDevin, ResponsesInputError } from "../src/convert.ts";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";

test("declaration 24 rejection records only bounded metadata, with validation unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "declaration-diagnostic-"));
  try {
    const path = join(directory, "safe.jsonl");
    const d = new ResponsesSafeDiagnostic("synthetic-declaration", Date.now(), path);
    const tools = Array.from({ length: 24 }, (_, i) => ({ type: "function", name: `mcp__memory__lookup_${i}`, parameters: { type: "object" } }));
    const rejected = { type: "synthetic_optional", name: "synthetic_feature", parameters: { description: "PRIVATE_SCHEMA" }, arguments: "PRIVATE_ARGUMENTS", prompt: "PRIVATE_PROMPT" };
    expect(() => responsesToolsetToDevin([...tools, rejected], value => {
      expect(Object.keys(value).sort()).toEqual(["category", "container", "index", "name", "namespace", "type"]);
      d.recordRejectedDeclaration(value);
    })).toThrow(ResponsesInputError);
    d.finalize();
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw).rejected_declaration).toEqual({ index: 24, container: "tools", type: "synthetic_optional", name: "synthetic_feature", category: "unsupported_type" });
    for (const content of ["PRIVATE_SCHEMA", "PRIVATE_ARGUMENTS", "PRIVATE_PROMPT"]) expect(raw).not.toContain(content);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("additional_tools rejection records its container and namespace; identifiers are sanitized", () => {
  const directory = mkdtempSync(join(tmpdir(), "declaration-private-"));
  try {
    for (const [i, name] of ["synthetic_feature", "bad\nname", "x".repeat(129), "api_key_value", "syntheticCredentialValue"].entries()) {
      const path = join(directory, `${i}.jsonl`);
      const d = new ResponsesSafeDiagnostic("synthetic-private", Date.now(), path);
      d.addCredentialValues(["syntheticCredentialValue"]);
      for (let j = 0; j < 100; j++) d.recordNormalizedUpstreamToolCall({ id: `id-${j}`, name: "old_tool" });
      expect(() => responsesToolsetToDevin([{ type: "additional_tools", tools: [{ type: "namespace", name: "mcp__memory", tools: [{ type: "synthetic_unknown", name }] }] }], value => d.recordRejectedDeclaration(value))).toThrow(ResponsesInputError);
      d.finalize();
      const raw = readFileSync(path, "utf8");
      expect(JSON.parse(raw).rejected_declaration).toEqual({ index: 0, container: "additional_tools", namespace: "mcp__memory", type: "synthetic_unknown", category: "unsupported_function_type", ...(i === 0 ? { name } : {}) });
      if (i !== 0) expect(raw).not.toContain(name);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
