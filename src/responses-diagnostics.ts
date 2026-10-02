import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { ProtoDecoder } from "./proto.js";

export const RESPONSES_SAFE_DIAGNOSTICS_ENV = "DEVIN_RESPONSES_SAFE_DIAGNOSTICS";
export const RESPONSES_SAFE_DIAGNOSTICS_PATH_ENV = "DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH";
const DEFAULT_LOG_PATH = resolve(process.cwd(), "logs", "responses-safe-diagnostic.jsonl");
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
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
  tool_calls: Array<{ name: string; call_id: string }>;
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

export class ResponsesSafeDiagnostic {
  private readonly record: ResponsesSafeDiagnosticRecord;
  private readonly secrets = new Set<string>();
  private readonly startedAt: number;
  private finalized = false;
  private deferred = false;

  constructor(
    requestId: string,
    startedAt = Date.now(),
    private readonly outputPath = resolve(process.env[RESPONSES_SAFE_DIAGNOSTICS_PATH_ENV]?.trim() || DEFAULT_LOG_PATH),
  ) {
    this.startedAt = startedAt;
    this.record = {
      timestamp: new Date(startedAt).toISOString(),
      request_id: identifier(requestId) ?? "invalid_request_id",
      tool_count: 0,
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
    if (!logical || !concrete || typeof requestedEffort !== "string" ||
      !["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(requestedEffort)) return;
    this.record.logical_model = logical;
    this.record.requested_effort = requestedEffort;
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
    const safeCallId = safeTraceId(callId, this.secrets);
    if (!safeName || !safeCallId || this.record.tool_calls.length >= 16) return;
    if (!this.record.tool_calls.some((call) => call.call_id === safeCallId)) {
      this.record.tool_calls.push({ name: safeName, call_id: safeCallId });
    }
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
    const safeRecord = Object.fromEntries(
      RESPONSES_SAFE_DIAGNOSTIC_FIELDS.map((field) => [field, this.record[field]]),
    );
    const line = `${JSON.stringify(safeRecord)}\n`;
    try {
      mkdirSync(dirname(this.outputPath), { recursive: true });
      appendFileSync(this.outputPath, line, { encoding: "utf8" });
      this.secrets.clear();
      return true;
    } catch {
      this.secrets.clear();
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
