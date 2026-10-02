import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResponsesSafeDiagnostic,
  responsesSafeDiagnosticsEnabled,
} from "../src/responses-diagnostics.ts";

test("safe Responses diagnostics are explicitly opt-in", () => {
  expect(responsesSafeDiagnosticsEnabled(undefined)).toBe(false);
  expect(responsesSafeDiagnosticsEnabled("true")).toBe(false);
  expect(responsesSafeDiagnosticsEnabled("1")).toBe(true);
});

test("routing diagnostics retain safe model metadata and reject secret values", () => {
  const directory = mkdtempSync(join(tmpdir(), "candidate-diagnostic-test-"));
  try {
    const path = join(directory, "safe.jsonl");
    const diagnostic = new ResponsesSafeDiagnostic("synthetic-candidate", Date.now(), path);
    diagnostic.recordRouting("SYNTHETIC_SECRET", "high", "swe-2-high");
    diagnostic.recordRouting("swe-2", "max", "swe-2-max");
    diagnostic.recordRouting("swe-2", "high", "SYNTHETIC_SECRET");
    diagnostic.finalize();
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.logical_model).toBe("swe-2");
    expect(record.requested_effort).toBe("max");
    expect(record.resolved_model_id).toBe("swe-2-max");
    expect(record).not.toHaveProperty("terminal_status");
    expect(readFileSync(path, "utf8")).not.toContain("SYNTHETIC_SECRET");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("diagnostic JSONL contains allowlisted hashes and normalized errors, never raw input or credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "devin-responses-diagnostic-test-"));
  const path = join(directory, "responses-safe-diagnostic.jsonl");
  const prompt = "SYNTHETIC_PRIVATE_PROMPT_DO_NOT_PERSIST_8f02";
  const instruction = "SYNTHETIC_SYSTEM_INSTRUCTION_DO_NOT_PERSIST_b61e";
  const apiToken = "SYNTHETIC_API_TOKEN_DO_NOT_PERSIST_4c18";
  const cookie = "SYNTHETIC_COOKIE_DO_NOT_PERSIST_23a1";
  const description = "SYNTHETIC_TOOL_DESCRIPTION_DO_NOT_PERSIST_9b2d";
  const schema = '{"description":"SYNTHETIC_SCHEMA_DO_NOT_PERSIST_70e1"}';

  try {
    const diagnostic = new ResponsesSafeDiagnostic("req_safe_1", Date.now(), path);
    diagnostic.addSensitiveValues([apiToken, cookie, JSON.stringify({ prompt, instruction })]);
    diagnostic.setRequestSummary({
      modelId: "glm-5-3-flash-low",
      instructions: instruction,
      userInput: prompt,
      collapseSystemEnabled: true,
      collapsedUserPayload: `<system>${instruction}</system>${prompt}`,
      tools: [{
        name: "exec_command",
        originalName: "exec_command",
        description,
        jsonSchemaString: schema,
        strict: true,
      }],
    });
    diagnostic.recordUpstreamResponse(200, true, ["trace-12345678"]);
    diagnostic.recordUpstreamResponse(200, false, [], "auth");
    diagnostic.recordUpstreamEvent("toolcall");
    diagnostic.recordUpstreamEvent("text");
    diagnostic.recordToolCall("exec_command", "call-123");
    diagnostic.recordConnectError({
      code: "permission_denied",
      message: `MCP configuration issue: ${prompt}; Authorization: Bearer ${apiToken}; Cookie: ${cookie}`,
      traceIds: ["trace-12345678"],
    });
    diagnostic.recordFailure({
      source: "gateway_responses_stream_catch",
      classification: "devin_policy_denial",
      message: prompt,
      terminalStatus: "connect_error",
    });
    expect(diagnostic.finalize()).toBe(true);

    const serialized = readFileSync(path, "utf8");
    const lines = serialized.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    for (const raw of [prompt, instruction, apiToken, cookie, description, schema, "SYNTHETIC_SCHEMA_DO_NOT_PERSIST_70e1"]) {
      expect(serialized).not.toContain(raw);
    }

    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      request_id: "req_safe_1",
      model_id: "glm-5-3-flash-low",
      tool_names: ["exec_command"],
      collapse_system_enabled: true,
      upstream_http_status: 200,
      upstream_http_statuses: [{ stage: "chat", status: 200 }, { stage: "auth", status: 200 }],
      upstream_event_count: 2,
      connect_error_code: "permission_denied",
      connect_error_message: "MCP configuration issue",
      devin_trace_id: "trace-12345678",
      response_failed_source: "gateway_responses_stream_catch",
      failure_classification: "devin_policy_denial",
    });
    expect(record.instruction_byte_length).toBe(Buffer.byteLength(instruction, "utf8"));
    expect(record.user_input_byte_length).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(record.forwarded_tool_fingerprints[0].schema_sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unsafe or secret-like trace IDs are omitted", () => {
  const directory = mkdtempSync(join(tmpdir(), "devin-responses-trace-test-"));
  const path = join(directory, "record.jsonl");
  try {
    const diagnostic = new ResponsesSafeDiagnostic("req_safe_2", Date.now(), path);
    diagnostic.addSensitiveValues(["private-token-value"]);
    diagnostic.recordUpstreamResponse(200, true, ["private-token-value", "Bearer-secret-123456"]);
    diagnostic.finalize();
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.devin_trace_id).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("diagnostic fields reject unrecognized Connect codes and count only recognized upstream event types", () => {
  const directory = mkdtempSync(join(tmpdir(), "devin-responses-allowlist-test-"));
  const path = join(directory, "record.jsonl");
  try {
    const diagnostic = new ResponsesSafeDiagnostic("req_safe_3", Date.now(), path);
    (diagnostic as unknown as { record: Record<string, unknown> }).record.raw_prompt = "UNALLOWLISTED_FIELD_MUST_NOT_BE_WRITTEN";
    diagnostic.recordUpstreamEvent("thinking");
    diagnostic.recordUpstreamEvent("private prompt should not be an event");
    diagnostic.recordConnectError({ code: "synthetic-private-token", message: "unclassified backend prose" });
    diagnostic.finalize();
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record).toMatchObject({
      upstream_event_count: 1,
      upstream_event_types: ["thinking"],
      connect_error_code: "unknown",
      connect_error_message: "Upstream error message redacted",
    });
    expect(readFileSync(path, "utf8")).not.toContain("synthetic-private-token");
    expect(readFileSync(path, "utf8")).not.toContain("private prompt should not be an event");
    expect(readFileSync(path, "utf8")).not.toContain("UNALLOWLISTED_FIELD_MUST_NOT_BE_WRITTEN");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
