/**
 * Convert between OpenAI / Anthropic request formats and Devin's internal
 * ChatMessagePrompt representation, and convert Devin stream events back to
 * the appropriate response shapes.
 */

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

const CODEX_RESPONSES_TOOL_NAMES = new Set(["exec_command"]);
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
  /** Devin-facing function name -> original Responses identity. */
  identities: Map<string, ResponsesToolIdentity>;
}

function devinToolName(namespace: string | undefined, name: string): string {
  return namespace === CODEX_MULTI_AGENT_NAMESPACE ? `${namespace}__${name}` : name;
}

/** Convert only the Codex tools proven by the Responses tool-loop POC. */
export function responsesToolsetToDevin(tools?: unknown): ResponsesToolset {
  if (tools === undefined) return { tools: [], identities: new Map() };
  if (!Array.isArray(tools)) {
    throw new ResponsesInputError("Responses tools must be an array.");
  }
  const result: ResponsesToolset = { tools: [], identities: new Map() };
  const addFunction = (tool: Record<string, unknown>, index: number, namespace?: string) => {
    if (tool.type !== "function" || "function" in tool) return;
    if (typeof tool.name !== "string" || !tool.name.trim()) {
      throw new ResponsesInputError(`Responses function tool at index ${index} needs a non-empty name.`);
    }
    const name = tool.name;
    const allowed = namespace === CODEX_MULTI_AGENT_NAMESPACE
      ? CODEX_MULTI_AGENT_TOOL_NAMES.has(name)
      : namespace === undefined && CODEX_RESPONSES_TOOL_NAMES.has(name);
    if (!allowed) return;
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new ResponsesInputError(`Responses function tool '${name}' description must be a string.`);
    }
    if (!isRecord(tool.parameters)) {
      throw new ResponsesInputError(`Responses function tool '${name}' needs an object JSON Schema in parameters.`);
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw new ResponsesInputError(`Responses function tool '${name}' strict must be a boolean.`);
    }

    const devinName = devinToolName(namespace, name);
    if (result.identities.has(devinName)) {
      throw new ResponsesInputError(`Duplicate Responses function declaration '${namespace ? `${namespace}.` : ""}${name}'.`);
    }
    // Devin rejects Codex's full exec_command prose although its schema is
    // accepted. Keep the schema unchanged and replace only this description.
    const description = name === "exec_command" && namespace === undefined
      ? "Run a local command."
      : tool.description ?? "";
    result.tools.push({
      name: devinName,
      description,
      jsonSchemaString: JSON.stringify(tool.parameters),
      strict: tool.strict ?? false,
    });
    result.identities.set(devinName, namespace ? { namespace, name } : { name });
  };

  for (const [index, value] of tools.entries()) {
    if (!isRecord(value)) continue;
    if (value.type === "function") {
      addFunction(value, index);
      continue;
    }
    if (value.type !== "namespace" || value.name !== CODEX_MULTI_AGENT_NAMESPACE) continue;
    if (!Array.isArray(value.tools)) {
      throw new ResponsesInputError(`Responses namespace '${CODEX_MULTI_AGENT_NAMESPACE}' needs a tools array.`);
    }
    for (const nested of value.tools) {
      if (isRecord(nested)) addFunction(nested, index, CODEX_MULTI_AGENT_NAMESPACE);
    }
  }

  return result;
}

/** Decode the Responses input subset needed for Codex tool-call history. */
export function responsesInputToOpenAIMessages(input: unknown): OpenAIMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) {
    throw new ResponsesInputError("Responses input must be a string or an array of input items.");
  }

  const messages: OpenAIMessage[] = [];
  for (const [index, item] of input.entries()) {
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

    if (item.type === "function_call") {
      const callId = requireString(item.call_id, `function_call at index ${index} call_id`);
      const responseName = requireString(item.name, `function_call at index ${index} name`);
      const namespace = item.namespace === undefined
        ? undefined
        : requireString(item.namespace, `function_call at index ${index} namespace`);
      const supported = namespace === undefined
        ? CODEX_RESPONSES_TOOL_NAMES.has(responseName)
        : namespace === CODEX_MULTI_AGENT_NAMESPACE && CODEX_MULTI_AGENT_TOOL_NAMES.has(responseName);
      if (!supported) {
        throw new ResponsesInputError(`Unsupported Responses function namespace '${namespace}.${responseName}'.`);
      }
      const name = devinToolName(namespace, responseName);
      const args = requireString(item.arguments, `function_call '${name}' arguments`);
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
        tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
      });
      continue;
    }

    if (item.type === "function_call_output") {
      const callId = requireString(item.call_id, `function_call_output at index ${index} call_id`);
      if (typeof item.output !== "string") {
        throw new ResponsesInputError(`function_call_output '${callId}' output must be a string.`);
      }
      messages.push({ role: "tool", tool_call_id: callId, content: item.output });
      continue;
    }

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

function responsesMessageContent(
  content: unknown,
  role: "system" | "developer" | "user" | "assistant",
  messageIndex: number,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new ResponsesInputError(`Responses ${role} message at index ${messageIndex} needs text content.`);
  }
  return content.map((part, partIndex) => {
    if (!isRecord(part)) {
      throw new ResponsesInputError(`Responses content part ${partIndex} in message ${messageIndex} must be an object.`);
    }
    if (!["input_text", "output_text", "text"].includes(String(part.type)) || typeof part.text !== "string") {
      throw new ResponsesInputError(
        `Unsupported Responses content part type ${JSON.stringify(part.type)} in message ${messageIndex}.`,
      );
    }
    return part.text;
  }).join("");
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
