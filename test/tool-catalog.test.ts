import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { responsesToolsetToDevin, ResponsesInputError } from "../src/convert.ts";
import { ProtoDecoder, encodeGetChatMessageRequest, type ChatToolDefinition } from "../src/proto.ts";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";
import { incomingCatalog, catalogSchema } from "./fixtures/tool-catalog.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function encode(tools: ChatToolDefinition[]) {
  return encodeGetChatMessageRequest({
    metadata: { ideName: "synthetic", ideVersion: "1", extensionName: "synthetic", extensionVersion: "1", apiKey: "synthetic", locale: "en" },
    prompt: "", chatMessagePrompts: [], chatModelUid: "synthetic-model", tools,
    configuration: { numCompletions: 1n, maxTokens: 100n, maxNewlines: 10n, temperature: 0.4, firstTemperature: 0.4, topK: 50n, topP: 1, stopPatterns: [], fimEotProbThreshold: 1 },
    disableParallelToolCalls: true, toolChoice: { optionName: "auto" }, cascadeId: "synthetic", executionId: "synthetic",
  });
}
function decodeTools(bytes: Uint8Array): ChatToolDefinition[] {
  const decoder = new ProtoDecoder(bytes); const tools: ChatToolDefinition[] = [];
  while (!decoder.done) {
    const tag = decoder.readTag();
    if (tag.field !== 10 || tag.wire !== 2) { decoder.skip(tag.wire); continue; }
    tools.push(decoder.readMessage(d => {
      const tool = { name: "", description: "", jsonSchemaString: "", strict: false };
      while (!d.done) {
        const { field, wire } = d.readTag();
        if (wire === 2 && field === 1) tool.name = d.readString();
        else if (wire === 2 && field === 2) tool.description = d.readString();
        else if (wire === 2 && field === 3) tool.jsonSchemaString = d.readString();
        else if (wire === 0 && field === 12) tool.strict = d.readVarint() !== 0n;
        else d.skip(wire);
      }
      return tool;
    }));
  }
  return tools;
}

for (const count of [16, 32, 64, 128]) {
  test(`incoming catalog ${count}: intentional six-tool filtering, reorder and schema isolation`, () => {
    const input = incomingCatalog(count); const original = JSON.stringify(input);
    const start = performance.now(); const result = responsesToolsetToDevin(input); const translateMs = performance.now() - start;
    expect(result.tools).toHaveLength(6);
    const reversed = responsesToolsetToDevin([...input].reverse());
    expect(Object.fromEntries(reversed.identities)).toEqual(Object.fromEntries(result.identities));
    expect(new Map(reversed.tools.map(t => [t.name, t]))).toEqual(new Map(result.tools.map(t => [t.name, t])));
    expect(JSON.stringify(input)).toBe(original);
    const decoded = decodeTools(encode(result.tools)); expect(decoded).toEqual(result.tools);
    expect(new Set(decoded.map(t => hash(t.jsonSchemaString))).size).toBe(6);
    expect(decoded[0].description).toBe("Run a local command.");
    for (const tool of decoded) expect(JSON.parse(tool.jsonSchemaString).properties.nested).toBeDefined();
    console.log(JSON.stringify({ fixture: "incoming-catalog", raw_functions: count + 18, forwarded: decoded.length, request_json_bytes: Buffer.byteLength(original), forwarded_proto_bytes: encode(result.tools).length, translate_ms: Number(translateMs.toFixed(3)) }));
  });

  test(`generic protobuf catalog ${count}: repeated serialization is lossless, not Responses support expansion`, () => {
    const start = performance.now();
    const tools = Array.from({ length: count }, (_, i) => ({ name: `synthetic_namespace_${i}__search`, description: "Synthetic private description", jsonSchemaString: JSON.stringify(catalogSchema(i)), strict: i % 2 === 0 }));
    const schemaMs = performance.now() - start;
    const encodeStart = performance.now(); const wire = encode(tools); const encodeMs = performance.now() - encodeStart;
    expect(decodeTools(wire)).toEqual(tools);
    console.log(JSON.stringify({ fixture: "generic-protobuf-only", count, proto_bytes: wire.length, schema_ms: Number(schemaMs.toFixed(3)), encode_ms: Number(encodeMs.toFixed(3)) }));
  });
}

test("unsupported namespace/case/long-name/flattened aliases never shadow the reviewed identities", () => {
  const input = incomingCatalog(128);
  input.unshift(...["Exec_Command", "exec_command__", "multi_agent_v1__spawn_agent", "e".repeat(1024)].map(name => ({ type: "function", name, parameters: {} })));
  input.push({ type: "namespace", name: "MULTI_AGENT_V1", tools: [{ type: "function", name: "spawn_agent", parameters: {} }] });
  const result = responsesToolsetToDevin(input);
  expect(result.tools).toHaveLength(6);
  expect(result.identities.get("multi_agent_v1__spawn_agent")).toEqual({ namespace: "multi_agent_v1", name: "spawn_agent" });
  expect(result.identities.has("namespace_a__search")).toBe(false);
  expect(result.identities.has("namespace_b__search")).toBe(false);
});

test("duplicates and malformed supported declarations fail; unsupported declarations are deliberately ignored", () => {
  const valid = { type: "function", name: "exec_command", parameters: {} };
  expect(() => responsesToolsetToDevin([valid, valid])).toThrow(ResponsesInputError);
  const namespace = { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "send_input", parameters: {} }] };
  expect(() => responsesToolsetToDevin([namespace, namespace])).toThrow(ResponsesInputError);
  for (const parameters of [null, [], "invalid", false]) expect(() => responsesToolsetToDevin([{ ...valid, parameters }])).toThrow(ResponsesInputError);
  expect(() => responsesToolsetToDevin([{ ...valid, strict: "true" }])).toThrow(ResponsesInputError);
  expect(() => responsesToolsetToDevin([{ ...valid, description: 1 }])).toThrow(ResponsesInputError);
  // Object shape is validated, not JSON Schema semantics. Characterize, don't broaden policy.
  expect(responsesToolsetToDevin([{ ...valid, parameters: { type: "synthetic-invalid-json-schema-type" } }]).tools).toHaveLength(1);
  expect(responsesToolsetToDevin([{ type: "function", name: "synthetic_unsupported", parameters: "invalid" }]).tools).toHaveLength(0);
});

test("large accepted schemas and preserved namespace descriptions are not truncated", () => {
  const description = "Synthetic private description " + "x".repeat(131072);
  const schema = catalogSchema(1, 262144);
  const result = responsesToolsetToDevin([{ type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "send_input", description, parameters: schema, strict: true }] }]);
  expect(decodeTools(encode(result.tools))).toEqual(result.tools);
  expect(result.tools[0].description).toBe(description);
  expect(hash(result.tools[0].jsonSchemaString)).toBe(hash(JSON.stringify(schema)));
});

test("generic protobuf strings retain case and long names without implying Responses eligibility", () => {
  const names = ["namespace_a__search", "namespace_b__search", "namespace_a__read", "namespace_b__read", "Search", "search", "synthetic_namespace_" + "n".repeat(256) + "__" + "f".repeat(512)];
  const tools = names.map((name, i) => ({ name, description: "Synthetic", jsonSchemaString: JSON.stringify(catalogSchema(i)), strict: false }));
  expect(decodeTools(encode(tools))).toEqual(tools);
  expect(new Set(decodeTools(encode(tools)).map(t => t.name)).size).toBe(names.length);
});

test("diagnostic catalog detail considers first 64 source entries; raw descriptions/schemas never enter records", () => {
  for (const count of [6, 16, 32, 64, 128]) {
    let record: unknown;
    const d = new ResponsesSafeDiagnostic("synthetic-catalog", Date.now(), undefined, r => { record = r; }, false);
    d.setRequestSummary({ tools: Array.from({ length: count }, (_, i) => ({ name: `synthetic_tool_${i}`, originalName: `synthetic_tool_${i}`, description: "Synthetic private description", jsonSchemaString: JSON.stringify(catalogSchema(i)), strict: true })) });
    d.finalize();
    const r = record as { tool_count: number; tool_names: string[]; forwarded_tool_fingerprints: unknown[] };
    expect(r.tool_count).toBe(Math.min(count, 64));
    expect(r.tool_names).toEqual(Array.from({ length: Math.min(count, 64) }, (_, i) => `synthetic_tool_${i}`));
    expect(r.forwarded_tool_fingerprints).toHaveLength(Math.min(count, 64));
    const json = JSON.stringify(record); expect(json).not.toContain("Synthetic private"); expect(json).not.toContain("synthetic-schema-");
    console.log(JSON.stringify({ fixture: "diagnostic-only", input_tools: count, reported_tools: r.tool_count, record_bytes: Buffer.byteLength(json) }));
  }
  let retained = 0;
  const d = new ResponsesSafeDiagnostic("synthetic-invalid-name", Date.now(), undefined, r => { retained = r.tool_count; }, false);
  d.setRequestSummary({ tools: Array.from({ length: 65 }, (_, i) => ({ name: i === 0 ? "x".repeat(129) : `synthetic_tool_${i}`, originalName: `synthetic_tool_${i}` })) });
  d.finalize(); expect(retained).toBe(63); // Invalid first entry isn't replaced by entry 65.
});
