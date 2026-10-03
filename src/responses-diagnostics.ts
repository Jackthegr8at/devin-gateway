import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ProtoDecoder } from "./proto.js";
import type { OpenAIMessage } from "./convert.js";

export const RESPONSES_SAFE_DIAGNOSTICS_ENV = "DEVIN_RESPONSES_SAFE_DIAGNOSTICS";
export const RESPONSES_SAFE_DIAGNOSTICS_PATH_ENV = "DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH";
const DEFAULT_LOG_PATH = resolve(process.cwd(), "logs", "responses-safe-diagnostic.jsonl");
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
// Responses/protobuf call IDs are opaque strings, not display identifiers.
// Operational budget, not a provider/schema limit: 1024 pending IDs * 4096
// UTF-8 bytes bounds ID payload near 4 MiB (plus JS/map overhead).
export const MAX_CORRELATION_CALL_ID_BYTES = 4096;
export function opaqueCallId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CORRELATION_CALL_ID_BYTES
    || Buffer.byteLength(value, "utf8") > MAX_CORRELATION_CALL_ID_BYTES
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    || !value.isWellFormed()) return undefined;
  return value;
}
const CONNECT_CODES = new Set([
  "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists",
  "permission_denied", "resource_exhausted", "failed_precondition", "aborted", "out_of_range",
  "unavailable", "internal", "unauthenticated", "data_loss",
]);
const UPSTREAM_EVENT_TYPES = new Set(["text", "thinking", "toolcall", "usage", "done", "error"]);

export function safeConnectCode(value: unknown): string {
  const candidate = typeof value === "string" ? value.toLowerCase() : "";
  return CONNECT_CODES.has(candidate) ? candidate : "unknown";
}

export type ResponsesFailureClassification =
  | "devin_policy_denial"
  | "devin_upstream_model_provider_unavailable"
  | "devin_connect_error"
  | "devin_stream_error"
  | "gateway_conversion_error"
  | "gateway_internal_error";

export interface ResponsesDiagnosticTool {
  name: string;
  namespace?: string;
  originalName: string;
  description?: string;
  jsonSchemaString?: string;
  strict?: boolean;
}

interface ToolMapping {
  tool_name: string;
  namespace: string | null;
  function_name: string;
}

interface ToolFingerprint {
  tool_name: string;
  description_byte_length: number;
  description_sha256: string;
  schema_byte_length: number;
  schema_sha256: string;
  strict: boolean;
}

export interface ResponsesSafeDiagnosticRecord {
  timestamp: string;
  request_id: string;
  model_id?: string;
  logical_model?: string;
  requested_effort?: string;
  resolved_model_id?: string;
  terminal_status?: string;
  had_tool_call: boolean;
  had_function_call_output: boolean;
  tool_choice_mode?: "omitted" | "auto" | "none" | "required" | "specific";
  requested_specific_tool?: string;
  upstream_tool_choice_mode?: "auto" | "none" | "required" | "specific";
  client_parallel_tool_calls?: boolean;
  upstream_parallel_tool_calls?: boolean;
  normalized_input_type_counts: Partial<Record<NormalizedInputType, number>>;
  upstream_toolcall_event_count: number;
  normalized_tool_call_object_count: number;
  bridge_completed_tool_call_count: number;
  responses_tool_call_emitted_count: number;
  tool_evidence_emitted_count: number;
  tool_evidence_returned_count: number;
  function_call_output_input_count: number;
  identifier_checks: Array<{ stage: IdentifierStage; field: "call_id" | "tool_name" | "model_id"; state: "accepted" | "rejected"; reason: IdentifierReason | "none"; sensitive_text_overlap: boolean }>;
  bridge_outcomes: Partial<Record<BridgeOutcome, number>>;
  correlation_results: Partial<Record<CorrelationOutcome, number>>;
  tool_count: number;
  tool_names: string[];
  tool_mappings: ToolMapping[];
  forwarded_tool_fingerprints: ToolFingerprint[];
  collapse_system_enabled?: boolean;
  original_system_byte_length?: number;
  original_system_sha256?: string;
  collapsed_user_payload_byte_length?: number;
  collapsed_user_payload_sha256?: string;
  instruction_byte_length?: number;
  instruction_sha256?: string;
  user_input_byte_length?: number;
  user_input_sha256?: string;
  upstream_stream_opened: boolean;
  upstream_http_status?: number;
  upstream_http_statuses: Array<{ stage: "auth" | "chat"; status: number }>;
  first_upstream_event_type?: string;
  upstream_event_count: number;
  upstream_event_types: string[];
  tool_calls: Array<{ name: string }>;
  upstream_terminal_status?: string;
  upstream_error_code?: string;
  connect_error_code?: string;
  connect_error_message?: string;
  sanitized_error_message?: string;
  devin_trace_id?: string;
  response_failed_source?: string;
  failure_classification?: ResponsesFailureClassification;
  elapsed_ms: number;
}

export const RESPONSES_SAFE_DIAGNOSTIC_FIELDS = [
  "timestamp",
  "request_id",
  "model_id",
  "logical_model",
  "requested_effort",
  "resolved_model_id",
  "terminal_status",
  "had_tool_call",
  "had_function_call_output",
  "tool_choice_mode", "requested_specific_tool", "upstream_tool_choice_mode",
  "client_parallel_tool_calls", "upstream_parallel_tool_calls", "normalized_input_type_counts",
  "upstream_toolcall_event_count", "normalized_tool_call_object_count", "bridge_completed_tool_call_count",
  "responses_tool_call_emitted_count", "tool_evidence_emitted_count", "tool_evidence_returned_count",
  "function_call_output_input_count", "identifier_checks", "bridge_outcomes", "correlation_results",
  "tool_count",
  "tool_names",
  "tool_mappings",
  "forwarded_tool_fingerprints",
  "collapse_system_enabled",
  "original_system_byte_length",
  "original_system_sha256",
  "collapsed_user_payload_byte_length",
  "collapsed_user_payload_sha256",
  "instruction_byte_length",
  "instruction_sha256",
  "user_input_byte_length",
  "user_input_sha256",
  "upstream_stream_opened",
  "upstream_http_status",
  "upstream_http_statuses",
  "first_upstream_event_type",
  "upstream_event_count",
  "upstream_event_types",
  "tool_calls",
  "upstream_terminal_status",
  "upstream_error_code",
  "connect_error_code",
  "connect_error_message",
  "sanitized_error_message",
  "devin_trace_id",
  "response_failed_source",
  "failure_classification",
  "elapsed_ms",
] as const satisfies readonly (keyof ResponsesSafeDiagnosticRecord)[];

export function responsesSafeDiagnosticsEnabled(value = process.env[RESPONSES_SAFE_DIAGNOSTICS_ENV]): boolean {
  return value === "1";
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  return IDENTIFIER.test(candidate) ? candidate : undefined;
}

function digest(value: string): { byteLength: number; sha256: string } {
  return {
    byteLength: Buffer.byteLength(value, "utf8"),
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function safeTraceId(value: unknown, secrets: Set<string>): string | undefined {
  const candidate = identifier(value);
  if (!candidate || /(?:token|secret|api.?key|bearer)/i.test(candidate)) return undefined;
  for (const secret of secrets) {
    if (secret.length >= 4 && (candidate.includes(secret) || secret.includes(candidate))) return undefined;
  }
  return candidate;
}

/** Persist only fixed category labels, never arbitrary upstream error prose. */
export function normalizedErrorMessage(value: unknown): string {
  const message = String(value ?? "");
  if (providerUnavailableMessage(message)) return "Third-party model provider unavailable";
  if (/mcp\s+configuration\s+issue/i.test(message)) return "MCP configuration issue";
  if (/content\s+policy/i.test(message)) return "Content policy denial";
  if (/rate[_\s-]?limit|quota/i.test(message)) return "Rate limit";
  if (/unauthorized|authentication|invalid.{0,16}token/i.test(message)) return "Authentication error";
  if (/permission[_\s-]?denied/i.test(message)) return "Permission denied";
  if (/deadline.{0,12}exceeded|timed?\s*out|timeout/i.test(message)) return "Upstream timeout";
  if (/internal|server error/i.test(message)) return "Upstream internal error";
  return "Upstream error message redacted";
}

const PROVIDER_UNAVAILABLE_REASONS = new Set(["MODEL_PROVIDER_UNAVAILABLE", "THIRD_PARTY_PROVIDER_UNAVAILABLE", "THIRD_PARTY_MODEL_PROVIDER_UNAVAILABLE"]);
function providerUnavailableMessage(message: string): boolean {
  return /third[ -]party\s+(?:model\s+)?provider/i.test(message)
    && /(?:not|currently\s+not)\s+available|unavailable|experiencing\s+(?:issues|problems)/i.test(message);
}
/** Decode only the standard ErrorInfo reason; never retain its metadata or raw details. */
function providerUnavailableReason(details: unknown): boolean {
  if (!Array.isArray(details)) return false;
  return details.slice(0, 16).some(detail => {
    if (!detail || typeof detail !== "object") return false;
    if (detail.type !== "google.rpc.ErrorInfo" && detail.type !== "type.googleapis.com/google.rpc.ErrorInfo"
      && detail["@type"] !== "type.googleapis.com/google.rpc.ErrorInfo") return false;
    if (PROVIDER_UNAVAILABLE_REASONS.has(detail.reason)) return true;
    if (typeof detail.value !== "string" || detail.value.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(detail.value)) return false;
    try {
      const decoder = new ProtoDecoder(Buffer.from(detail.value, "base64"));
      let reason: string | undefined;
      while (!decoder.done) {
        const { field, wire } = decoder.readTag();
        if (field === 1 && wire === 2) { if (reason !== undefined) return false; reason = decoder.readString(); }
        else decoder.skip(wire);
      }
      return reason !== undefined && PROVIDER_UNAVAILABLE_REASONS.has(reason);
    } catch { return false; }
  });
}
function connectClassification(code: string, message: string, details?: unknown): ResponsesFailureClassification {
  if (code === "permission_denied" && /content\s*policy|mcp configuration issue/i.test(message)) {
    return "devin_policy_denial";
  }
  if (providerUnavailableReason(details) || (["invalid_argument", "unavailable"].includes(code) && providerUnavailableMessage(message))) {
    return "devin_upstream_model_provider_unavailable";
  }
  return "devin_connect_error";
}

export interface ToolValidationEvidence {
  emitted: Array<{ id: string; name: string }>;
  returned: Array<{ id: string; success: boolean }>;
}
type NormalizedInputType = "system" | "developer" | "user" | "assistant" | "assistant_function_call" | "assistant_reasoning" | "function_call_output";
type IdentifierStage = "routing" | "upstream_object" | "emitted_evidence" | "returned_evidence" | "history" | "tool_choice";
type IdentifierReason = "missing" | "invalid_format" | "secret_like" | "redaction_collision";
type BridgeOutcome = "unidentified_delta" | "same_id_delta" | "multiple_call_conflict" | "missing_name" | "undeclared_name" | "invalid_arguments_json" | "arguments_not_object" | "evidence_limit";
export type CorrelationOutcome = "request_ineligible" | "expired_pending" | "no_issued_call" | "scope_mismatch" | "model_mismatch" | "effort_mismatch" | "tool_result_not_successful" | "matched_success" | "issued_call_recorded";
function increment<T extends string>(counts: Partial<Record<T, number>>, key: T): void {
  counts[key] = Math.min(1_000_000, (counts[key] ?? 0) + 1);
}
export class ResponsesSafeDiagnostic {
  private readonly record: ResponsesSafeDiagnosticRecord;
  private readonly secrets = new Set<string>();
  // Credentials stay protected even in validated structured bridge fields.
  // Prompt/schema occurrences of an ID are not themselves credentials.
  private readonly credentials = new Set<string>();
  private readonly startedAt: number;
  private finalized = false;
  private deferred = false;
  private readonly evidence: ToolValidationEvidence = { emitted: [], returned: [] };

  constructor(
    requestId: string,
    startedAt = Date.now(),
    private readonly outputPath = resolve(process.env[RESPONSES_SAFE_DIAGNOSTICS_PATH_ENV]?.trim() || DEFAULT_LOG_PATH),
    private readonly observer?: (record: ResponsesSafeDiagnosticRecord, evidence: ToolValidationEvidence) => void,
    private readonly writeLog = true,
  ) {
    this.startedAt = startedAt;
    this.record = {
      timestamp: new Date(startedAt).toISOString(),
      request_id: identifier(requestId) ?? "invalid_request_id",
      tool_count: 0,
      had_tool_call: false,
      had_function_call_output: false,
      normalized_input_type_counts: {},
      upstream_toolcall_event_count: 0,
      normalized_tool_call_object_count: 0,
      bridge_completed_tool_call_count: 0,
      responses_tool_call_emitted_count: 0,
      tool_evidence_emitted_count: 0,
      tool_evidence_returned_count: 0,
      function_call_output_input_count: 0,
      identifier_checks: [],
      bridge_outcomes: {},
      correlation_results: {},
      tool_names: [],
      tool_mappings: [],
      forwarded_tool_fingerprints: [],
      upstream_stream_opened: false,
      upstream_http_statuses: [],
      upstream_event_count: 0,
      upstream_event_types: [],
      tool_calls: [],
      elapsed_ms: 0,
    };
  }

  addSensitiveValues(values: unknown[]): void {
    for (const value of values) {
      if (typeof value === "string" && value.length >= 4) this.secrets.add(value);
    }
  }

  addCredentialValues(values: unknown[]): void {
    this.addSensitiveValues(values);
    for (const value of values) {
      if (typeof value === "string" && value.length >= 4) this.credentials.add(value);
    }
  }

  private checkedIdentifier(value: unknown, stage: IdentifierStage, field: "call_id" | "tool_name" | "model_id", structured: boolean): string | undefined {
    const candidate = typeof value === "string" ? (structured ? value : value.trim()) : "";
    const sensitive = structured ? this.credentials : this.secrets;
    const collision = (values: Set<string>) => [...values].some(v => v.length >= 4 && candidate.length > 0 && (candidate.includes(v) || v.includes(candidate)));
    let reason: IdentifierReason | undefined;
    if (!candidate.trim()) reason = "missing";
    else if (!IDENTIFIER.test(structured ? candidate : candidate.trim())) reason = "invalid_format";
    else if (/(?:token|secret|api.?key|bearer)/i.test(candidate)) reason = "secret_like";
    else if (collision(sensitive)) reason = "redaction_collision";
    if (this.record.identifier_checks.length < 64) this.record.identifier_checks.push({ stage, field, state: reason ? "rejected" : "accepted", reason: reason ?? "none", sensitive_text_overlap: collision(this.secrets) });
    return reason ? undefined : safeTraceId(value, sensitive);
  }

  private structuredIdentifier(value: unknown, stage: IdentifierStage = "routing", field: "call_id" | "tool_name" | "model_id" = "model_id"): string | undefined {
    // No trimming/coercion: only exact validated bridge identifiers qualify.
    return this.checkedIdentifier(value, stage, field, true);
  }

  private correlationIdentifier(value: unknown, stage: IdentifierStage, structured = true): string | undefined {
    const candidate = opaqueCallId(value);
    const collision = (values: Set<string>) => typeof value === "string" && [...values].some(v => v.length >= 4 && (value.includes(v) || v.includes(value)));
    // Privacy is separate from syntax. Trusted bridge identities may occur in
    // prompts/history, but never bypass registered credentials or secret markers.
    const reason: IdentifierReason | undefined = typeof value !== "string" || !value.trim() ? "missing"
      : !candidate ? "invalid_format"
      : /(?:token|secret|api.?key|bearer)/i.test(candidate) ? "secret_like"
      : collision(structured ? this.credentials : this.secrets) ? "redaction_collision" : undefined;
    if (this.record.identifier_checks.length < 64) this.record.identifier_checks.push({ stage, field: "call_id", state: reason ? "rejected" : "accepted", reason: reason ?? "none", sensitive_text_overlap: collision(this.secrets) });
    return reason ? undefined : candidate;
  }

  recordRequestStructure(messages: OpenAIMessage[], requestedChoice: unknown, choice: { optionName?: string; toolName?: string } | undefined, parallel: unknown): void {
    this.record.tool_choice_mode = requestedChoice === undefined ? "omitted" : choice?.toolName ? "specific" : requestedChoice === "required" ? "required" : requestedChoice === "none" ? "none" : "auto";
    this.record.upstream_tool_choice_mode = choice?.toolName ? "specific" : choice?.optionName === "any" ? "required" : choice?.optionName === "none" ? "none" : "auto";
    if (choice?.toolName) this.record.requested_specific_tool = this.structuredIdentifier(choice.toolName, "tool_choice", "tool_name");
    if (typeof parallel === "boolean") this.record.client_parallel_tool_calls = parallel;
    this.record.upstream_parallel_tool_calls = false; // Existing Devin request contract.
    for (const message of messages) {
      const type = message.role === "tool" ? "function_call_output" : message.tool_calls?.length ? "assistant_function_call" : message.reasoning_content ? "assistant_reasoning" : message.role;
      if (["system", "developer", "user", "assistant", "assistant_function_call", "assistant_reasoning", "function_call_output"].includes(type)) increment(this.record.normalized_input_type_counts, type as NormalizedInputType);
    }
    this.record.function_call_output_input_count = this.record.normalized_input_type_counts.function_call_output ?? 0;
  }

  recordNormalizedUpstreamToolCall(call: { id: string; name: string }): void {
    this.record.normalized_tool_call_object_count++;
    this.correlationIdentifier(call.id, "upstream_object");
    this.structuredIdentifier(call.name, "upstream_object", "tool_name");
  }
  recordBridgeOutcome(outcome: BridgeOutcome): void { increment(this.record.bridge_outcomes, outcome); }
  recordResponsesToolCallEmitted(): void { this.record.responses_tool_call_emitted_count++; }

  /** Call only after the request's model/effort has passed gateway resolution. */
  recordResolvedRouting(route: { logicalModel: string; requestedEffort: unknown; resolvedModelId: string }): void {
    const logical = this.structuredIdentifier(route.logicalModel);
    const concrete = this.structuredIdentifier(route.resolvedModelId);
    if (!logical || !concrete) return;
    this.record.model_id = logical;
    this.record.logical_model = logical;
    this.record.resolved_model_id = concrete;
    if (typeof route.requestedEffort === "string" && ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(route.requestedEffort)) {
      this.record.requested_effort = route.requestedEffort;
    }
  }

  /** Completed accumulator output, not unvalidated deltas or assistant history. */
  recordNormalizedEmittedToolCall(call: { id: string; name: string }): void {
    this.record.bridge_completed_tool_call_count++;
    const id = this.correlationIdentifier(call.id, "emitted_evidence");
    const name = this.structuredIdentifier(call.name, "emitted_evidence", "tool_name");
    if (!id || !name) return;
    if (this.evidence.emitted.length >= 16) { this.recordBridgeOutcome("evidence_limit"); return; }
    this.record.had_tool_call = true;
    this.evidence.emitted.push({ id, name });
    this.record.tool_evidence_emitted_count++;
    if (!this.record.tool_calls.some(entry => entry.name === name) && this.record.tool_calls.length < 16) {
      this.record.tool_calls.push({ name });
    }
  }

  /** Validated Responses converter output; never inspect raw input/history text. */
  recordNormalizedFunctionCallOutput(message: OpenAIMessage, success: boolean): void {
    if (message.role !== "tool") return;
    const id = this.correlationIdentifier(message.tool_call_id, "returned_evidence");
    if (!id) return;
    if (this.evidence.returned.length >= 16) { this.recordBridgeOutcome("evidence_limit"); return; }
    this.record.had_function_call_output = true;
    this.evidence.returned.push({ id, success });
    this.record.tool_evidence_returned_count++;
  }

  setRequestSummary(options: {
    modelId?: unknown;
    instructions?: string;
    userInput?: string;
    tools: ResponsesDiagnosticTool[];
    collapseSystemEnabled?: boolean;
    collapsedUserPayload?: string;
    sensitiveValues?: unknown[];
  }): void {
    const instruction = digest(options.instructions ?? "");
    const user = digest(options.userInput ?? "");
    this.record.instruction_byte_length = instruction.byteLength;
    this.record.instruction_sha256 = instruction.sha256;
    this.record.original_system_byte_length = instruction.byteLength;
    this.record.original_system_sha256 = instruction.sha256;
    this.record.user_input_byte_length = user.byteLength;
    this.record.user_input_sha256 = user.sha256;
    this.record.collapse_system_enabled = options.collapseSystemEnabled === true;
    this.addSensitiveValues([
      options.instructions,
      options.userInput,
      options.collapsedUserPayload,
      ...(options.sensitiveValues ?? []),
    ]);

    if (options.collapseSystemEnabled && options.collapsedUserPayload !== undefined) {
      const collapsed = digest(options.collapsedUserPayload);
      this.record.collapsed_user_payload_byte_length = collapsed.byteLength;
      this.record.collapsed_user_payload_sha256 = collapsed.sha256;
    }

    const mappings = options.tools.slice(0, 64).flatMap((tool) => {
      const name = identifier(tool.name);
      const namespace = tool.namespace ? identifier(tool.namespace) : undefined;
      const functionName = identifier(tool.originalName);
      if (!name || !functionName || (tool.namespace && !namespace)) return [];
      return [{ tool_name: name, namespace: namespace ?? null, function_name: functionName }];
    });
    this.record.tool_count = mappings.length;
    this.record.tool_names = mappings.map((mapping) => mapping.tool_name);
    this.record.tool_mappings = mappings;
    this.record.forwarded_tool_fingerprints = options.tools.slice(0, 64).flatMap((tool) => {
      const name = identifier(tool.name);
      if (!name) return [];
      const description = digest(tool.description ?? "");
      const schema = digest(tool.jsonSchemaString ?? "");
      return [{
        tool_name: name,
        description_byte_length: description.byteLength,
        description_sha256: description.sha256,
        schema_byte_length: schema.byteLength,
        schema_sha256: schema.sha256,
        strict: tool.strict === true,
      }];
    });
    this.addSensitiveValues(options.tools.flatMap((tool) => [tool.description, tool.jsonSchemaString]));
    this.record.model_id = safeTraceId(options.modelId, this.secrets);
  }

  deferFinalization(): void {
    this.deferred = true;
  }

  /** Metadata only: bounded identifiers, known efforts, and existing secret redaction. */
  recordRouting(logicalModel: unknown, requestedEffort: unknown, resolvedModelId: unknown): void {
    const logical = safeTraceId(logicalModel, this.secrets);
    const concrete = safeTraceId(resolvedModelId, this.secrets);
    if (!logical || !concrete) return;
    this.record.logical_model = logical;
    if (typeof requestedEffort === "string" && ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(requestedEffort)) this.record.requested_effort = requestedEffort;
    this.record.resolved_model_id = concrete;
  }

  recordUpstreamResponse(
    status: number,
    streamOpened: boolean,
    traceIds: unknown[] = [],
    stage: "auth" | "chat" = "chat",
  ): void {
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      if (stage === "chat") this.record.upstream_http_status = status;
      if (!this.record.upstream_http_statuses.some((entry) => entry.stage === stage && entry.status === status)) {
        this.record.upstream_http_statuses.push({ stage, status });
      }
    }
    if (stage === "chat") this.record.upstream_stream_opened = streamOpened;
    this.recordTraceIds(traceIds);
  }

  recordTraceIds(traceIds: unknown[]): void {
    for (const value of traceIds) {
      const traceId = safeTraceId(value, this.secrets);
      if (traceId) {
        this.record.devin_trace_id = traceId;
        return;
      }
    }
  }

  recordUpstreamEvent(type: string): void {
    if (!UPSTREAM_EVENT_TYPES.has(type)) return;
    const safeType = type;
    this.record.upstream_event_count += 1;
    if (type === "toolcall") this.record.upstream_toolcall_event_count++;
    if (!this.record.first_upstream_event_type) this.record.first_upstream_event_type = safeType;
    if (!this.record.upstream_event_types.includes(safeType) && this.record.upstream_event_types.length < 16) {
      this.record.upstream_event_types.push(safeType);
    }
  }

  recordUpstreamComplete(): void {
    this.record.upstream_terminal_status = "completed";
  }

  recordToolCall(name: unknown, callId: unknown): void {
    const safeName = identifier(name);
    const safeCallId = this.correlationIdentifier(callId, "history", false);
    if (!safeName || !safeCallId || this.record.tool_calls.length >= 16) return;
    if (!this.record.tool_calls.some((call) => call.name === safeName)) {
      this.record.tool_calls.push({ name: safeName });
    }
  }

  /** Only completed, validated emitted calls qualify; history/deltas never do. */
  recordEmittedToolCall(name: unknown, callId: unknown): void {
    const id = safeTraceId(callId, this.secrets); const safeName = identifier(name);
    if (!id || !safeName || this.evidence.emitted.length >= 16) return;
    this.record.had_tool_call = true;
    this.evidence.emitted.push({ id, name: safeName });
  }
  recordFunctionCallOutput(callId: unknown, success: boolean): void {
    const id = safeTraceId(callId, this.secrets);
    if (!id || this.evidence.returned.length >= 16) return;
    this.record.had_function_call_output = true;
    this.evidence.returned.push({ id, success });
  }

  recordConnectError(options: { code?: unknown; message?: unknown; details?: unknown; traceIds?: unknown[] }): void {
    const code = safeConnectCode(options.code);
    const message = String(options.message ?? "");
    this.record.connect_error_code = code;
    this.record.upstream_error_code = code;
    this.record.connect_error_message = normalizedErrorMessage(message);
    this.record.failure_classification = connectClassification(code, message, options.details);
    if (this.record.failure_classification === "devin_upstream_model_provider_unavailable") this.record.connect_error_message = "Third-party model provider unavailable";
    this.record.upstream_terminal_status = "connect_error";
    this.recordTraceIds(options.traceIds ?? []);
  }

  recordUpstreamError(options: { terminalStatus: string; code?: unknown; message?: unknown; traceIds?: unknown[] }): void {
    this.record.upstream_terminal_status = identifier(options.terminalStatus) ?? "upstream_error";
    if (options.code !== undefined) this.record.upstream_error_code = safeConnectCode(options.code);
    if (options.message !== undefined) this.record.sanitized_error_message = normalizedErrorMessage(options.message);
    this.record.failure_classification ??= /timeout|stream|frame/i.test(options.terminalStatus)
      ? "devin_stream_error"
      : "devin_connect_error";
    this.recordTraceIds(options.traceIds ?? []);
  }

  get failureClassification(): ResponsesFailureClassification | undefined {
    return this.record.failure_classification;
  }

  get upstreamTerminalStatus(): string | undefined {
    return this.record.upstream_terminal_status;
  }

  get hasFailure(): boolean {
    return Boolean(this.record.response_failed_source && this.record.response_failed_source !== "none");
  }

  get isDeferred(): boolean {
    return this.deferred;
  }

  recordFailure(options: {
    source: string;
    classification?: ResponsesFailureClassification;
    message?: unknown;
    terminalStatus?: string;
  }): void {
    this.record.response_failed_source = identifier(options.source) ?? "gateway_internal_error";
    this.record.failure_classification = options.classification
      ?? this.record.failure_classification
      ?? "gateway_internal_error";
    if (options.message !== undefined && !this.record.connect_error_message && !this.record.sanitized_error_message) {
      this.record.sanitized_error_message = normalizedErrorMessage(options.message);
    }
    if (options.terminalStatus) {
      this.record.upstream_terminal_status = identifier(options.terminalStatus) ?? "gateway_error";
    }
  }

  recordSuccessfulCompletion(): void {
    if (!this.record.upstream_terminal_status) this.record.upstream_terminal_status = "completed";
    this.record.response_failed_source = "none";
  }

  finalizeIfNotDeferred(): boolean {
    if (this.deferred) return false;
    return this.finalize();
  }

  finalize(): boolean {
    if (this.finalized) return false;
    this.finalized = true;
    this.record.elapsed_ms = Math.max(0, Date.now() - this.startedAt);
    if (this.record.resolved_model_id) this.record.terminal_status = this.record.upstream_terminal_status;
    // Correlation annotates fixed outcome counters before serialization.
    try { this.observer?.(this.record, this.evidence); } catch { /* Observability never changes inference. */ }
    const safeRecord = Object.fromEntries(
      RESPONSES_SAFE_DIAGNOSTIC_FIELDS.map((field) => [field, this.record[field]]),
    );
    const line = `${JSON.stringify(safeRecord)}\n`;
    if (!this.writeLog) { this.secrets.clear(); this.credentials.clear(); return true; }
    try {
      mkdirSync(dirname(this.outputPath), { recursive: true });
      appendFileSync(this.outputPath, line, { encoding: "utf8" });
      this.secrets.clear();
      this.credentials.clear();
      return true;
    } catch {
      this.secrets.clear();
      this.credentials.clear();
      return false;
    }
  }
}

const diagnosticContext = new AsyncLocalStorage<ResponsesSafeDiagnostic>();

export function runWithResponsesDiagnostic<T>(diagnostic: ResponsesSafeDiagnostic, callback: () => T): T {
  return diagnosticContext.run(diagnostic, callback);
}

export function currentResponsesDiagnostic(): ResponsesSafeDiagnostic | undefined {
  return diagnosticContext.getStore();
}
