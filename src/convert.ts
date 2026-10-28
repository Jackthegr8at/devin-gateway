/**
 * Convert between OpenAI / Anthropic request formats and Devin's internal
 * ChatMessagePrompt representation, and convert Devin stream events back to
 * the appropriate response shapes.
 */

import { createHash } from "node:crypto";
import {
  type ChatMessagePrompt,
  type ChatToolCall,
  type ChatToolDefinition,
  type ImageData,
  ChatMessageSource,
  StopReason,
} from "./proto.js";

// ─── Common internal message shape ───────────────────────────────────────────

export interface InternalMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  images?: ImageData[];
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  isError?: boolean;
  thinking?: string;
}

// ─── OpenAI → Internal ───────────────────────────────────────────────────────

export interface OpenAIMessage {
  /** Internal history metadata; never an executable declaration. */
  historicalCustomCall?: boolean;
  historicalToolIdentity?: ResponsesToolIdentity;
  role: string;
  content?: string | OpenAIContentPart[];
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: string;
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export class ResponsesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesInputError";
  }
}

const CODEX_MULTI_AGENT_NAMESPACE = "multi_agent_v1";
const CODEX_MULTI_AGENT_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_input",
  "wait_agent",
  "resume_agent",
  "close_agent",
]);

export interface ResponsesToolIdentity {
  name: string;
  namespace?: string;
}

export interface ResponsesToolset {
  tools: ChatToolDefinition[];
  nativeWebSearchUnavailable?: true;
  /** Devin-facing function name -> original Responses identity. */
  identities: Map<string, ResponsesToolIdentity>;
}

export interface DuplicateToolDeclaration {
  outcome: "identical" | "key_order_equivalent" | "conflicting";
  comparison?: { differences: Array<{ path: string; category: string; change: "added" | "removed" | "type" | "value" }>; truncated: boolean };
  first: { container: "tools" | "additional_tools"; index: number; structural_hash: string };
  second: { container: "tools" | "additional_tools"; index: number; structural_hash: string };
}

export interface RejectedToolDeclaration {
  index: number;
  container: "tools" | "additional_tools";
  type: unknown;
  name: unknown;
  namespace?: unknown;
  category: "unsupported_type" | "unsupported_function_type";
}

function devinToolName(namespace: string | undefined, name: string): string {
  return namespace === CODEX_MULTI_AGENT_NAMESPACE ? `${namespace}__${name}` : name;
}

export const WRITE_STDIN_DEVIN_DESCRIPTION = "Send input to a running command session or read its output.";

function declaredDevinToolName(namespace: string | undefined, name: string): string {
  if (namespace === CODEX_MULTI_AGENT_NAMESPACE && CODEX_MULTI_AGENT_TOOL_NAMES.has(name)) return devinToolName(namespace, name);
  if (namespace === undefined && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)
    && !name.startsWith("cx_") && !name.startsWith(`${CODEX_MULTI_AGENT_NAMESPACE}__`)) return name;
  // Stable bounded names; the request-local identity map is the inverse. A hash
  // collision is checked explicitly below, never accepted as an alias.
  return "cx_" + createHash("sha256").update(JSON.stringify([namespace ?? null, name])).digest("hex").slice(0, 60);
}

/** Compare JSON objects independently of insertion order; array order remains significant.
 * This deliberately does not guess equivalence between different JSON Schemas.
 */
function declarationSignature(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(declarationSignature).join(",") + "]";
  if (isRecord(value)) return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + declarationSignature(value[key])).join(",") + "}";
  return JSON.stringify(value);
}

/** Fixed keywords are visible; arbitrary field names are hashed, never values. */
function compareDeclarationStructure(left: unknown, right: unknown): NonNullable<DuplicateToolDeclaration["comparison"]> {
  const result: NonNullable<DuplicateToolDeclaration["comparison"]> = { differences: [], truncated: false };
  const keywords = new Set(["description", "parameters", "required", "strict", "type", "properties", "items", "enum", "const", "additionalProperties", "anyOf", "allOf", "oneOf", "$defs", "$ref", "default"]);
  const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
  let visited = 0;
  const walk = (a: unknown, b: unknown, path: string, category: string, depth: number, mapKeys = false, presence?: "added" | "removed") => {
    if (++visited > 1024 || depth > 16 || result.differences.length >= 32 || path.length > 512) { result.truncated = true; return; }
    const kind = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    const emit = (change: "added" | "removed" | "type" | "value") => result.differences.push({ path, category, change });
    if (presence) { emit(presence); return; }
    if (kind(a) !== kind(b)) { emit("type"); return; }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        walk(a[i], b[i], path + "/" + i, category, depth + 1, false, i >= a.length ? "added" : i >= b.length ? "removed" : undefined);
        if (result.truncated) break;
      }
    } else if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const token = !mapKeys && keywords.has(key) ? key : "key-sha256-" + createHash("sha256").update(key).digest("hex").slice(0, 16);
        const nextCategory = key === "description" && !mapKeys ? "description" : depth === 0 && key === "parameters" ? "parameters" : key === "required" && !mapKeys ? "required" : depth === 0 && key === "strict" ? "strictness" : category;
        walk(a[key], b[key], path + "/" + token, nextCategory, depth + 1, !mapKeys && maps.has(key), !Object.hasOwn(a, key) ? "added" : !Object.hasOwn(b, key) ? "removed" : undefined);
        if (result.truncated) break;
      }
    } else if (a !== b) emit("value");
  };
  walk(left, right, "", "metadata", 0);
  return result;
}

/** Select the request's explicit catalog, or the leading Responses Lite catalog.
 * Later additional_tools snapshots do not grant executable capabilities.
 * Reference: OpenCodex hasPlaintextV2CollaborationCatalog; selection is generic.
 */
export function responsesExecutableDeclarations(tools: unknown, input: unknown): unknown {
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new ResponsesInputError("Responses tools must be an array.");
    return tools;
  }
  if (!Array.isArray(input)) return undefined;
  const initial = input[0];
  if (isRecord(initial) && initial.type === "additional_tools" && initial.role === "developer") {
    if (!Array.isArray(initial.tools)) throw new ResponsesInputError("Leading Responses Lite catalog needs a tools array.");
    return initial.tools;
  }
  return undefined;
}

/**
 * Forward current JSON-schema function declarations for client-side execution.
 * Historical custom declarations remain records, not executable capabilities.
 */
export function responsesToolsetToDevin(tools?: unknown, onRejected?: (declaration: RejectedToolDeclaration) => void, onDuplicate?: (declaration: DuplicateToolDeclaration) => void): ResponsesToolset {
  if (tools === undefined) return { tools: [], identities: new Map() };
  if (!Array.isArray(tools)) {
    throw new ResponsesInputError("Responses tools must be an array.");
  }
  const result: ResponsesToolset = { tools: [], identities: new Map() };
  const sentDeclarations = new Map<string, { signature: string; raw: string; container: "tools" | "additional_tools"; index: number }>();
  // Codex sends the same declarations in top-level `tools` and, when a
  // conversation is duplicated across models, in `additional_tools` replacement
  // history. Both use one namespace/function shape, so one walker handles both.
  const addDeclaration = (value: Record<string, unknown>, index: number, historical = false) => {
    if (value.type === "web_search") {
      result.nativeWebSearchUnavailable = true;
      return;
    }
    if (value.type === "function") {
      addFunction(value, index, undefined, historical);
      return;
    }
    if (value.type === "additional_tools") {
      if (!Array.isArray(value.tools)) {
        throw new ResponsesInputError(`Responses additional_tools item at index ${index} needs a tools array.`);
      }
      for (const nested of value.tools) {
        if (!isRecord(nested)) throw new ResponsesInputError(`Invalid Responses tool declaration at index ${index}.`);
        addDeclaration(nested, index, true);
      }
      return;
    }
    if (value.type !== "namespace") {
      if (historical && value.type === "custom") return;
      onRejected?.({ index, container: historical ? "additional_tools" : "tools", type: value.type, name: value.name, namespace: value.namespace, category: "unsupported_type" });
      throw new ResponsesInputError(`Unsupported Responses tool declaration at index ${index}; only JSON-schema functions and namespaces are executable.`);
    }
    const namespace = requireString(value.name, `Responses namespace at index ${index} name`);
    if (!Array.isArray(value.tools)) {
      throw new ResponsesInputError(`Responses namespace at index ${index} needs a tools array.`);
    }
    for (const nested of value.tools) {
      if (!isRecord(nested)) throw new ResponsesInputError(`Invalid Responses namespace tool at index ${index}.`);
      if (historical && nested.type === "custom") continue;
      addFunction(nested, index, namespace, historical);
    }
  };

  const addFunction = (tool: Record<string, unknown>, index: number, namespace?: string, historical = false) => {
    if (tool.type !== "function" || "function" in tool) {
      onRejected?.({ index, container: historical ? "additional_tools" : "tools", type: tool.type, name: tool.name, namespace, category: "unsupported_function_type" });
      throw new ResponsesInputError(`Unsupported Responses function declaration at index ${index}.`);
    }
    if (typeof tool.name !== "string" || !tool.name.trim()) {
      throw new ResponsesInputError(`Responses function tool at index ${index} needs a non-empty name.`);
    }
    const name = tool.name;
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new ResponsesInputError(`Responses function tool '${name}' description must be a string.`);
    }
    if (!isRecord(tool.parameters)) {
      throw new ResponsesInputError(`Responses function tool '${name}' needs an object JSON Schema in parameters.`);
    }
    if (tool.parameters.type !== undefined && tool.parameters.type !== "object") {
      throw new ResponsesInputError(`Responses function tool at index ${index} needs an object input schema.`);
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw new ResponsesInputError(`Responses function tool '${name}' strict must be a boolean.`);
    }

    const devinName = declaredDevinToolName(namespace, name);
    const existingIdentity = result.identities.get(devinName);
    if (existingIdentity && (existingIdentity.name !== name || existingIdentity.namespace !== namespace)) {
      throw new ResponsesInputError("Responses tool identity collision; refusing ambiguous tool mapping.");
    }
    // Top-level tools and additional_tools can both declare the same function
    // with the same schema. Accept that repeat once; a conflicting one still fails.
    // Devin rejects Codex's exec_command/write_stdin prose although their
    // schemas are accepted. Normalize only these unnamespaced descriptions.
    const description = name === "exec_command" && namespace === undefined
      ? "Run a local command."
      : name === "write_stdin" && namespace === undefined ? WRITE_STDIN_DEVIN_DESCRIPTION
      : tool.description ?? "";
    // Compare what the client sent, not the normalized Devin copy: the
    // shell descriptions are rewritten below, which would hide a conflict.
    const comparable = {
      ...tool,
      description: tool.description ?? "",
      parameters: tool.parameters,
      strict: tool.strict ?? false,
    };
    const sent = declarationSignature(comparable);
    const raw = JSON.stringify(comparable);
    const container = historical ? "additional_tools" : "tools";
    const previous = sentDeclarations.get(devinName);
    if (previous !== undefined) {
      const digest = (signature: string) => createHash("sha256").update(signature).digest("hex");
      onDuplicate?.({ outcome: previous.signature !== sent ? "conflicting" : previous.raw === raw ? "identical" : "key_order_equivalent",
        first: { container: previous.container, index: previous.index, structural_hash: digest(previous.signature) },
        second: { container, index, structural_hash: digest(sent) },
        ...(previous.signature !== sent ? { comparison: compareDeclarationStructure(JSON.parse(previous.raw), comparable) } : {}) });
      if (previous.signature === sent) return;
      throw new ResponsesInputError(`Duplicate Responses function declaration '${namespace ? `${namespace}.` : ""}${name}': conflicting structural signatures from ${previous.container}[${previous.index}] (sha256=${digest(previous.signature)}) and ${historical ? "additional_tools" : "tools"}[${index}] (sha256=${digest(sent)}); executable-tool identity/precedence is unverified, refusing ambiguous schemas.`);
    }
    sentDeclarations.set(devinName, { signature: sent, raw, container, index });
    result.tools.push({
      name: devinName,
      description,
      jsonSchemaString: JSON.stringify(tool.parameters),
      strict: tool.strict ?? false,
    });
    result.identities.set(devinName, namespace ? { namespace, name } : { name });
  };

  for (const [index, value] of tools.entries()) {
    if (!isRecord(value)) throw new ResponsesInputError(`Invalid Responses tool declaration at index ${index}.`);
    addDeclaration(value, index);
  }

  return result;
}

export const CROSS_PROVIDER_SKIP_COMPACTION_ENV = "DEVIN_CROSS_PROVIDER_SKIP_COMPACTION";
export const CROSS_PROVIDER_COMPACTION_NOTE = "[Gateway notice: earlier compacted Codex context from another provider was unavailable and was omitted. Only the visible history below is available.]";

/**
 * Decode the Responses input subset needed for Codex tool-call history.
 * `skipCompaction` is an explicit operator opt-in: it drops only opaque
 * `compaction` items and records one notice at the first omitted position.
 */
export function responsesInputToOpenAIMessages(
  input: unknown,
  options: { skipCompaction?: boolean } = {},
): OpenAIMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) {
    throw new ResponsesInputError("Responses input must be a string or an array of input items.");
  }

  // Check the complete history before conversion: visible turns cannot replace
  // provider-specific context available only inside an opaque compaction item.
  const compactionIndex = input.findIndex((item) => isRecord(item) && item.type === "compaction");
  if (compactionIndex !== -1 && !options.skipCompaction) {
    throw new ResponsesInputError(
      `Cannot transfer Responses compaction at index ${compactionIndex}: provider-specific encrypted context cannot be read by this gateway. Continue with the original provider to create a visible text handoff, then start a new gateway conversation with that handoff.`,
    );
  }

  const messages: OpenAIMessage[] = [];
  let compactionNoticeAdded = false;
  for (const [index, item] of input.entries()) {
    if (compactionIndex !== -1 && isRecord(item) && item.type === "compaction") {
      if (!compactionNoticeAdded) {
        messages.push({ role: "user", content: CROSS_PROVIDER_COMPACTION_NOTE });
        compactionNoticeAdded = true;
      }
      continue;
    }
    if (!isRecord(item)) {
      throw new ResponsesInputError(`Responses input item at index ${index} must be an object.`);
    }

    if (item.type === "reasoning") {
      const summary = responsesReasoningSummary(item, index);
      // Empty reasoning wrappers carry no useful history; omit them while
      // preserving the relative order of the remaining input items.
      if (summary) messages.push({ role: "assistant", content: "", reasoning_content: summary });
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const callId = requireString(item.call_id, `tool call at index ${index} call_id`);
      const responseName = requireString(item.name, `tool call at index ${index} name`);
      const namespace = item.namespace === undefined
        ? undefined
        : requireString(item.namespace, `function_call at index ${index} namespace`);
      // Historical calls are records, not new executable declarations. Keep
      // foreign tool identities; the live declaration/output allowlist is unchanged.
      const name = namespace === undefined || namespace === CODEX_MULTI_AGENT_NAMESPACE
        ? devinToolName(namespace, responseName)
        : `${namespace}.${responseName}`;
      if (item.type === "custom_tool_call" && typeof item.input !== "string") {
        throw new ResponsesInputError(`custom_tool_call at index ${index} input must be a string.`);
      }
      // Devin's historical calls require JSON arguments. Wrap raw custom input
      // as data; never parse it as code/JSON, execute it, or declare a new tool.
      const args = item.type === "custom_tool_call"
        ? JSON.stringify({ input: item.input })
        : requireString(item.arguments, `function_call '${name}' arguments`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(args);
      } catch {
        throw new ResponsesInputError(`function_call '${name}' arguments are not valid JSON.`);
      }
      if (!isRecord(parsed)) {
        throw new ResponsesInputError(`function_call '${name}' arguments must decode to a JSON object.`);
      }
      messages.push({
        role: "assistant",
        content: "",
        ...(item.type === "custom_tool_call" ? { historicalCustomCall: true } : {}),
        ...(declaredDevinToolName(namespace, responseName) !== name
          ? { historicalToolIdentity: { name: responseName, ...(namespace === undefined ? {} : { namespace }) } } : {}),
        tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = requireString(item.call_id, `tool output at index ${index} call_id`);
      messages.push({ role: "tool", tool_call_id: callId, content: responsesHistoricalToolOutput(item.output, index) });
      continue;
    }

    // Tool declarations, not conversation turns. responsesToolsetToDevin reads
    // them from the same input array, so skip them here without losing history.
    if (item.type === "additional_tools") continue;

    if (item.type !== undefined && item.type !== "message") {
      throw new ResponsesInputError(
        `Unsupported Responses input item type ${JSON.stringify(item.type)} at index ${index}.`,
      );
    }
    if (
      item.role !== "user" && item.role !== "assistant" &&
      item.role !== "system" && item.role !== "developer"
    ) {
      throw new ResponsesInputError(
        `Responses message at index ${index} role must be 'system', 'developer', 'user', or 'assistant'.`,
      );
    }
    messages.push({
      role: item.role,
      content: responsesMessageContent(item.content, item.role, index),
    });
  }
  return messages;
}

function responsesHistoricalToolOutput(output: unknown, index: number): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.every((part) =>
    isRecord(part) && part.type === "input_text" && typeof part.text === "string"
  )) {
    // Preserve part boundaries, text bytes and order in a lossless text envelope.
    return JSON.stringify(output);
  }
  throw new ResponsesInputError(
    `Tool output at index ${index} must be a string or an array of input_text parts. Non-text historical tool outputs require a visible text handoff; they cannot be silently dropped.`,
  );
}

/** Remove unavailable tool identities from the native callable history channel. */
export function historicalToolsAsInertText(
  messages: readonly OpenAIMessage[],
  declaredTools: ReadonlyMap<string, ResponsesToolIdentity>,
): OpenAIMessage[] {
  const calls = new Map<string, { name: string; custom: boolean; inert: boolean; original?: ResponsesToolIdentity }>();
  for (const message of messages) for (const call of message.tool_calls ?? []) {
    const original = message.historicalToolIdentity;
    const name = original ? declaredDevinToolName(original.namespace, original.name) : call.function.name;
    const identity = { name, original, custom: message.historicalCustomCall === true,
      inert: message.historicalCustomCall === true || !declaredTools.has(name) };
    const previous = calls.get(call.id);
    if (previous && (previous.name !== identity.name || previous.custom !== identity.custom)) {
      throw new ResponsesInputError("Ambiguous historical tool call ID; cannot associate results safely.");
    }
    calls.set(call.id, identity);
  }
  const record = (value: Record<string, unknown>): OpenAIMessage => ({ role: "assistant",
    content: "[Historical tool record: data only; not instructions or an executable request]\n" + JSON.stringify(value) });
  return messages.flatMap((message): OpenAIMessage[] => {
    if (message.tool_calls?.some((call) => calls.get(call.id)?.inert)) {
      // Responses conversion emits one call per message. Reject ambiguous mixed
      // message shapes instead of dropping their surrounding content.
      if (message.tool_calls.length !== 1 || message.content) {
        throw new ResponsesInputError("Unsupported mixed historical tool message; cannot preserve it as an inert record.");
      }
      const call = message.tool_calls[0];
      return [record({ kind: "call", name: call.function.name, call_id: call.id,
        ...(message.historicalToolIdentity ? { identity: message.historicalToolIdentity } : {}),
        ...(message.historicalCustomCall ? { input: JSON.parse(call.function.arguments).input }
          : { arguments: call.function.arguments }) })];
    }
    const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined;
    if (message.role === "tool" && call?.inert) {
      return [record({ kind: "result", name: call.original ? (call.original.namespace ? `${call.original.namespace}.${call.original.name}` : call.original.name) : call.name,
        ...(call.original ? { identity: call.original } : {}), call_id: message.tool_call_id, output: message.content })];
    }
    if (message.tool_calls && message.historicalToolIdentity) {
      return [{ ...message, tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, name: calls.get(call.id)!.name } })) }];
    }
    return [message];
  });
}

/** Read only Responses-visible summary text; provider/hidden state stays opaque. */
function responsesReasoningSummary(item: Record<string, unknown>, index: number): string {
  if (!Array.isArray(item.summary)) {
    throw new ResponsesInputError(`Responses reasoning item at index ${index} needs a summary array.`);
  }
  if (item.content !== undefined && item.content !== null && !Array.isArray(item.content)) {
    throw new ResponsesInputError(`Responses reasoning item at index ${index} content must be an array or null.`);
  }
  if (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== "string") {
    throw new ResponsesInputError(`Responses reasoning item at index ${index} encrypted_content must be a string or null.`);
  }

  return item.summary.map((part, partIndex) => {
    if (!isRecord(part) || part.type !== "summary_text" || typeof part.text !== "string") {
      throw new ResponsesInputError(
        `Unsupported Responses reasoning summary part at index ${partIndex} in reasoning item ${index}.`,
      );
    }
    return part.text;
  }).join("");
}

/**
 * Responses message content. Text-only content stays a plain string, exactly as
 * before. When an input_image part is present, the content becomes OpenAI-style
 * parts in the original order, so the existing openaiToInternal path extracts
 * the image. Only base64 image data URLs are accepted; remote URLs and other
 * media types are rejected rather than dropped.
 */
function responsesMessageContent(
  content: unknown,
  role: "system" | "developer" | "user" | "assistant",
  messageIndex: number,
): string | OpenAIContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new ResponsesInputError(`Responses ${role} message at index ${messageIndex} needs text content.`);
  }
  const parts: OpenAIContentPart[] = [];
  let hasImage = false;
  for (const [partIndex, part] of content.entries()) {
    if (!isRecord(part)) {
      throw new ResponsesInputError(`Responses content part ${partIndex} in message ${messageIndex} must be an object.`);
    }
    if (part.type === "input_image") {
      if (role !== "user") {
        throw new ResponsesInputError(`Responses ${role} message at index ${messageIndex} cannot contain input_image parts.`);
      }
      const url = responsesInputImageUrl(part.image_url);
      if (url === null) {
        throw new ResponsesInputError(
          `Responses input_image part ${partIndex} in message ${messageIndex} needs a base64 image data URL.`,
        );
      }
      parts.push({ type: "image_url", image_url: { url } });
      hasImage = true;
      continue;
    }
    if (!["input_text", "output_text", "text"].includes(String(part.type)) || typeof part.text !== "string") {
      throw new ResponsesInputError(
        `Unsupported Responses content part type ${JSON.stringify(part.type)} in message ${messageIndex}.`,
      );
    }
    parts.push({ type: "text", text: part.text });
  }
  if (!hasImage) return parts.map((part) => part.text ?? "").join("");
  return parts;
}

/** Accept only `data:image/<png|jpeg|gif|webp>;base64,<payload>`; no remote fetch, no SVG. */
function responsesInputImageUrl(imageUrl: unknown): string | null {
  if (typeof imageUrl !== "string") return null;
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(imageUrl) ? imageUrl : null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ResponsesInputError(`${label} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openaiToInternal(messages: OpenAIMessage[]): InternalMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        toolCallId: msg.tool_call_id,
      };
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : "";
      const images = extractOpenAIImages(msg.content);
      return {
        role: "assistant",
        content: text,
        ...(msg.reasoning_content ? { thinking: msg.reasoning_content } : undefined),
        images,
        toolCalls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || "{}"),
        })),
      };
    }

    // user / system / developer
    const text = typeof msg.content === "string" ? msg.content : extractOpenAIText(msg.content);
    const images = extractOpenAIImages(msg.content);
    return { role: "user", content: text, images };
  });
}

function extractOpenAIText(content?: string | OpenAIContentPart[]): string {
  if (!content || typeof content === "string") return content ?? "";
  return content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}

function extractOpenAIImages(content?: string | OpenAIContentPart[]): ImageData[] {
  if (!content || typeof content === "string") return [];
  return content
    .filter((p) => p.type === "image_url" && p.image_url?.url)
    .map((p) => parseDataUrl(p.image_url!.url))
    .filter((img): img is ImageData => img !== null);
}

function parseDataUrl(url: string): ImageData | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
}

export function openaiToolsToDevin(tools?: OpenAITool[]): ChatToolDefinition[] {
  if (!tools) return [];
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    jsonSchemaString: JSON.stringify(t.function.parameters ?? { type: "object" }),
    strict: false,
  }));
}

// ─── Anthropic → Internal ────────────────────────────────────────────────────

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  source?: { type: string; media_type: string; data: string };
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export function anthropicToInternal(messages: AnthropicMessage[]): InternalMessage[] {
  const result: InternalMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content });
      continue;
    }

    // Group tool_result blocks into tool messages
    const blocks = msg.content;
    let textBuf = "";
    let thinkingBuf = "";
    const toolCalls: NonNullable<InternalMessage["toolCalls"]> = [];
    const images: ImageData[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          textBuf += block.text ?? "";
          break;
        case "thinking":
          thinkingBuf += block.thinking ?? "";
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: block.input ?? {},
          });
          break;
        case "tool_result": {
          const resultText = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("")
              : "";
          result.push({
            role: "tool",
            content: resultText,
            toolCallId: block.tool_use_id,
            isError: block.is_error,
          });
          break;
        }
        case "image":
          if (block.source?.type === "base64") {
            images.push({ mimeType: block.source.media_type, base64Data: block.source.data });
          }
          break;
      }
    }

    if (textBuf || thinkingBuf || toolCalls.length > 0 || images.length > 0) {
      result.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: textBuf,
        thinking: thinkingBuf || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        images: images.length > 0 ? images : undefined,
      });
    }
  }
  return result;
}

export function anthropicToolsToDevin(tools?: AnthropicTool[]): ChatToolDefinition[] {
  if (!tools) return [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    jsonSchemaString: JSON.stringify(t.input_schema ?? { type: "object" }),
    strict: false,
  }));
}

// ─── Internal → Devin ChatMessagePrompt ──────────────────────────────────────

export function toDevinPrompts(messages: InternalMessage[], cascadeId: string): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  for (const [index, msg] of messages.entries()) {
    const messageId = deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`);
    if (msg.role === "user") {
      prompts.push({
        messageId,
        source: ChatMessageSource.USER,
        prompt: msg.content,
        images: msg.images,
      });
    } else if (msg.role === "assistant") {
      prompts.push({
        messageId: `bot-${messageId}`,
        source: ChatMessageSource.SYSTEM,
        prompt: msg.content,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          argumentsJson: JSON.stringify(tc.arguments),
        })),
      });
    } else {
      prompts.push({
        messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId ?? ""}`),
        source: ChatMessageSource.TOOL,
        toolCallId: msg.toolCallId,
        toolResultIsError: msg.isError,
        prompt: msg.content,
        images: msg.images,
      });
    }
  }
  return prompts;
}

function deterministicUuid(seed: string): string {
  // Simple deterministic ID from seed (not a real UUID, but stable)
  let h1 = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-0000-0000-000000000000`;
}

// ─── Stop reason mapping ─────────────────────────────────────────────────────

export function stopReasonToOpenAI(reason: number, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_calls";
  if (reason === StopReason.MAX_TOKENS) return "length";
  return "stop";
}

export function stopReasonToAnthropic(reason: number, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  if (reason === StopReason.MAX_TOKENS) return "max_tokens";
  return "end_turn";
}
