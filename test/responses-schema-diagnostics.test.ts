import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";

function record(schemas: Array<string | undefined>) {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-schema-diagnostics-"));
  try {
    const path = join(dir, "safe.jsonl");
    const d = new ResponsesSafeDiagnostic("synthetic-schema", Date.now(), path);
    d.setRequestSummary({ tools: schemas.map((jsonSchemaString, i) => ({ name: `tool_${i}`, originalName: `tool_${i}`, jsonSchemaString, strict: false })) });
    d.finalize();
    return readFileSync(path, "utf8");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("schema diagnostics count only schema structure, never names or data-bearing values", () => {
  const secret = "SYNTHETIC_PRIVATE_SCHEMA_CONTENT";
  const schema = {
    type: "object", description: secret, additionalProperties: false, required: [secret],
    properties: { [secret]: { type: ["string", "null"], enum: [secret], default: { anyOf: [secret] }, examples: [{ $ref: secret }] } },
    $defs: { [secret]: { anyOf: [{ $ref: secret }, { type: "null", nullable: true }] } },
    const: { oneOf: [{ description: secret }] },
  };
  const raw = record([JSON.stringify(schema)]);
  expect(raw).not.toContain(secret);
  const structure = JSON.parse(raw).forwarded_tool_fingerprints[0].schema_structure;
  expect(structure).toEqual({
    status: "ok", nodes: 6, max_depth: 2, type_arrays: 1, closed_objects: 1,
    features: { required: 1, additionalProperties: 1, $defs: 1, const: 1, enum: 1, anyOf: 1, $ref: 1, nullable: 1 },
  });
  expect(structure.features.oneOf).toBeUndefined();
  expect(schema.properties[secret].type).toEqual(["string", "null"]);
});

test("true tool count remains independent of the bounded diagnostic catalog", () => {
  const r = JSON.parse(record(Array.from({ length: 71 }, () => '{"type":"object"}')));
  expect(r.tool_count).toBe(71);
  expect(r.tool_catalog_truncated).toBe(true);
  expect(r.tool_mappings).toHaveLength(64);
  expect(r.forwarded_tool_fingerprints).toHaveLength(64);
  expect(JSON.parse(record([]))).toMatchObject({ tool_count: 0, tool_catalog_truncated: false });
});

test("schema analysis has explicit byte, node and depth limits and fails safely", () => {
  let deep: any = { type: "string" };
  for (let i = 0; i < 40; i++) deep = { items: deep };
  const wide = { properties: Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`p${i}`, { type: "string" }])) };
  const schemas = [undefined, "not-json", "null", "[]", "true", JSON.stringify({ description: "x".repeat(128 * 1024) }), JSON.stringify(deep), JSON.stringify(wide)];
  const structures = JSON.parse(record(schemas)).forwarded_tool_fingerprints.map((f: any) => f.schema_structure);
  expect(structures.map((s: any) => s.status)).toEqual(["missing", "invalid", "invalid", "invalid", "ok", "truncated", "truncated", "truncated"]);
  for (const s of structures) { expect(s.nodes).toBeLessThanOrEqual(1024); expect(s.max_depth).toBeLessThanOrEqual(32); }
});
