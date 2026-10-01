import { describe, expect, test } from "bun:test";

import {
  openaiToInternal,
  anthropicToInternal,
  toDevinPrompts,
  openaiToolsToDevin,
  anthropicToolsToDevin,
  responsesInputToOpenAIMessages,
  responsesToolsetToDevin,
  ResponsesInputError,
  stopReasonToOpenAI,
  stopReasonToAnthropic,
  type OpenAIMessage,
  type OpenAITool,
  type AnthropicMessage,
  type AnthropicTool,
  type InternalMessage,
} from "../src/convert.ts";
import { ChatMessageSource, StopReason } from "../src/proto.ts";

describe("Codex Responses input conversion", () => {
  const schema = {
    type: "object",
    properties: { cmd: { type: "string", description: "command text" } },
    required: ["cmd"],
    additionalProperties: false,
  };

  test("normalizes only exec_command description and preserves its schema", () => {
    const result = responsesToolsetToDevin([
      { type: "function", name: "exec_command", description: "Codex's full local command instructions", parameters: schema, strict: true },
      { type: "function", name: "get_hostname", description: "test-only helper", parameters: { type: "object" } },
      { type: "function", name: "unrelated", description: "not forwarded", parameters: { type: "object" } },
    ]);

    expect(result.tools).toEqual([{
      name: "exec_command",
      description: "Run a local command.",
      jsonSchemaString: JSON.stringify(schema),
      strict: true,
    }]);
    expect(result.identities.get("exec_command")).toEqual({ name: "exec_command" });
    expect(result.identities.has("get_hostname")).toBe(false);
  });

  test("forwards exactly the five multi_agent_v1 functions and restores their identities", () => {
    const names = ["spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent"];
    const result = responsesToolsetToDevin([{
      type: "namespace",
      name: "multi_agent_v1",
      tools: names.map((name) => ({ type: "function", name, description: `${name} description`, parameters: schema })),
    }]);

    expect(result.tools.map((tool) => tool.name)).toEqual(names.map((name) => `multi_agent_v1__${name}`));
    expect(result.tools.every((tool) => tool.jsonSchemaString === JSON.stringify(schema))).toBe(true);
    for (const name of names) {
      expect(result.identities.get(`multi_agent_v1__${name}`)).toEqual({ namespace: "multi_agent_v1", name });
    }
  });

  test("drops unsupported namespaces and ignores unsupported tool declarations", () => {
    const result = responsesToolsetToDevin([
      { type: "namespace", name: "other_namespace", tools: [{ type: "function", name: "spawn_agent", parameters: schema }] },
      { type: "function", name: "exec_command", parameters: schema },
    ]);
    expect(result.tools).toHaveLength(1);
  });

  test("decodes function calls, namespace identity, results, reasoning, and messages in order", () => {
    const messages = responsesInputToOpenAIMessages([
      { type: "reasoning", summary: [{ type: "summary_text", text: "Prior reasoning" }] },
      { type: "function_call", id: "fc_item", call_id: "devin-call-id", namespace: "multi_agent_v1", name: "spawn_agent", arguments: '{"agent_type":"swe_worker"}' },
      { type: "function_call_output", call_id: "devin-call-id", output: "child complete" },
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ]);

    expect(messages).toEqual([
      { role: "assistant", content: "", reasoning_content: "Prior reasoning" },
      {
        role: "assistant", content: "", tool_calls: [{
          id: "devin-call-id", type: "function",
          function: { name: "multi_agent_v1__spawn_agent", arguments: '{"agent_type":"swe_worker"}' },
        }],
      },
      { role: "tool", tool_call_id: "devin-call-id", content: "child complete" },
      { role: "user", content: "Continue" },
    ]);
    expect(openaiToInternal(messages)[0].thinking).toBe("Prior reasoning");
  });

  test("rejects invalid function-call history and malformed tool declarations", () => {
    expect(() => responsesInputToOpenAIMessages([
      { type: "function_call", call_id: "c1", name: "exec_command", arguments: "[]" },
    ])).toThrow(ResponsesInputError);
    expect(() => responsesInputToOpenAIMessages([
      { type: "function_call", call_id: "c1", name: "multi_agent_v1__spawn_agent", arguments: "{}" },
    ])).toThrow(ResponsesInputError);
    expect(() => responsesToolsetToDevin([
      { type: "function", name: "exec_command", parameters: "not-an-object" },
    ])).toThrow(ResponsesInputError);
  });
});

// ─── openaiToInternal ────────────────────────────────────────────────────────

describe("openaiToInternal", () => {
  test("empty input yields empty output", () => {
    expect(openaiToInternal([])).toEqual([]);
  });

  test("tool message with string content passes content through and maps tool_call_id", () => {
    const out = openaiToInternal([
      { role: "tool", content: "result text", tool_call_id: "call_42" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("tool");
    expect(out[0].content).toBe("result text");
    expect(out[0].toolCallId).toBe("call_42");
  });

  test("tool message with object content is JSON.stringified", () => {
    const obj = { ok: true, n: 3 };
    const out = openaiToInternal([{ role: "tool", content: obj as unknown as string, tool_call_id: "c1" }]);
    expect(out[0].role).toBe("tool");
    expect(out[0].content).toBe(JSON.stringify(obj));
    expect(out[0].toolCallId).toBe("c1");
  });

  test("assistant with string content and no tool_calls has undefined toolCalls", () => {
    const out = openaiToInternal([{ role: "assistant", content: "hello" }]);
    expect(out[0].role).toBe("assistant");
    expect(out[0].content).toBe("hello");
    expect(out[0].toolCalls).toBeUndefined();
  });

  test("assistant with tool_calls parses arguments JSON into objects", () => {
    const out = openaiToInternal([
      {
        role: "assistant",
        content: "thinking",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
          { id: "t2", type: "function", function: { name: "noop", arguments: "" } },
        ],
      },
    ]);
    expect(out[0].toolCalls).toEqual([
      { id: "t1", name: "get_weather", arguments: { city: "SF" } },
      { id: "t2", name: "noop", arguments: {} },
    ]);
  });

  test("assistant with array content extracts image_url data URLs into images", () => {
    const out = openaiToInternal([
      {
        role: "assistant",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
          { type: "image_url", image_url: { url: "https://example.com/x.png" } },
        ],
      },
    ]);
    expect(out[0].content).toBe("");
    expect(out[0].images).toEqual([{ mimeType: "image/png", base64Data: "AAA=" }]);
  });

  test("user/system/developer roles all collapse to role 'user' with text content", () => {
    const out = openaiToInternal([
      { role: "user", content: "u" },
      { role: "system", content: "s" },
      { role: "developer", content: "d" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(out.map((m) => m.content)).toEqual(["u", "s", "d"]);
  });

  test("user with array content joins text parts and extracts image parts", () => {
    const out = openaiToInternal([
      {
        role: "user",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,Qk==" } },
        ],
      },
    ]);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("Hello world");
    expect(out[0].images).toEqual([{ mimeType: "image/jpeg", base64Data: "Qk==" }]);
  });

  test("malformed image URLs are filtered out, leaving empty images array", () => {
    const out = openaiToInternal([
      {
        role: "user",
        content: [
          { type: "text", text: "t" },
          { type: "image_url", image_url: { url: "not-a-data-url" } },
          { type: "image_url", image_url: { url: "data:image/png;base64," } },
        ],
      },
    ]);
    expect(out[0].content).toBe("t");
    expect(out[0].images).toEqual([]);
  });

  test("preserves message order across mixed roles", () => {
    const out = openaiToInternal([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "tool", content: "r", tool_call_id: "x" },
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });
});

// ─── anthropicToInternal ─────────────────────────────────────────────────────

describe("anthropicToInternal", () => {
  test("string content: user and assistant pass through with their role", () => {
    const out = anthropicToInternal([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("text blocks are aggregated into content", () => {
    const out = anthropicToInternal([
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("ab");
    expect(out[0].thinking).toBeUndefined();
  });

  test("thinking blocks are aggregated into thinking", () => {
    const out = anthropicToInternal([
      { role: "assistant", content: [{ type: "thinking", thinking: "p" }, { type: "thinking", thinking: "q" }] },
    ]);
    expect(out[0].thinking).toBe("pq");
    expect(out[0].content).toBe("");
  });

  test("tool_use blocks are collected into toolCalls with input as arguments", () => {
    const out = anthropicToInternal([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "search", input: { q: "x" } },
          { type: "tool_use", id: "tu2", name: "fetch", input: {} },
        ],
      },
    ]);
    expect(out[0].toolCalls).toEqual([
      { id: "tu1", name: "search", arguments: { q: "x" } },
      { id: "tu2", name: "fetch", arguments: {} },
    ]);
  });

  test("tool_result with string content produces an isolated tool message", () => {
    const out = anthropicToInternal([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "done" }] },
    ]);
    expect(out).toEqual([{ role: "tool", content: "done", toolCallId: "tu1", isError: undefined }]);
  });

  test("tool_result with block-array content joins only text blocks", () => {
    const out = anthropicToInternal([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [
              { type: "text", text: "part1 " },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "Z" } },
              { type: "text", text: "part2" },
            ],
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("tool");
    expect(out[0].content).toBe("part1 part2");
    expect(out[0].toolCallId).toBe("tu1");
  });

  test("tool_result propagates is_error to isError", () => {
    const out = anthropicToInternal([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "boom", is_error: true }] },
    ]);
    expect(out[0].isError).toBe(true);
  });

  test("a message with only tool_result does not emit an extra user/assistant message", () => {
    const out = anthropicToInternal([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "r" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("tool");
  });

  test("image block with base64 source maps to ImageData", () => {
    const out = anthropicToInternal([
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "BASE" } }],
      },
    ]);
    expect(out[0].images).toEqual([{ mimeType: "image/png", base64Data: "BASE" }]);
  });

  test("image block with non-base64 source is dropped", () => {
    const out = anthropicToInternal([
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", media_type: "image/png", data: "x" } }],
      },
    ]);
    // No text/thinking/toolCalls/images -> no message emitted
    expect(out).toEqual([]);
  });

  test("mixed text+thinking+tool_use in one message merge into a single assistant message", () => {
    const out = anthropicToInternal([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tu1", name: "do", input: { a: 1 } },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect(out[0].content).toBe("answer");
    expect(out[0].thinking).toBe("reason");
    expect(out[0].toolCalls).toEqual([{ id: "tu1", name: "do", arguments: { a: 1 } }]);
  });

  test("user-role text block yields role 'user'", () => {
    const out = anthropicToInternal([{ role: "user", content: [{ type: "text", text: "hey" }] }]);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toBe("hey");
  });
});

// ─── toDevinPrompts ──────────────────────────────────────────────────────────

describe("toDevinPrompts", () => {
  test("empty input yields empty output", () => {
    expect(toDevinPrompts([], "cascade-1")).toEqual([]);
  });

  test("user message maps to USER source with content and images", () => {
    const msgs: InternalMessage[] = [
      { role: "user", content: "hi", images: [{ mimeType: "image/png", base64Data: "A" }] },
    ];
    const [p] = toDevinPrompts(msgs, "c");
    expect(p.source).toBe(ChatMessageSource.USER);
    expect(p.prompt).toBe("hi");
    expect(p.images).toEqual([{ mimeType: "image/png", base64Data: "A" }]);
  });

  test("assistant message gets 'bot-' messageId prefix, SYSTEM source, thinking and toolCalls as argumentsJson", () => {
    const msgs: InternalMessage[] = [
      {
        role: "assistant",
        content: "a",
        thinking: "th",
        toolCalls: [{ id: "t1", name: "do", arguments: { x: 1 } }],
      },
    ];
    const [p] = toDevinPrompts(msgs, "c");
    expect(p.source).toBe(ChatMessageSource.SYSTEM);
    expect(p.messageId.startsWith("bot-")).toBe(true);
    expect(p.thinking).toBe("th");
    expect(p.toolCalls).toEqual([{ id: "t1", name: "do", argumentsJson: JSON.stringify({ x: 1 }) }]);
  });

  test("tool message maps to TOOL source with toolCallId, toolResultIsError, and prompt=content", () => {
    const msgs: InternalMessage[] = [
      { role: "tool", content: "result", toolCallId: "tu1", isError: true },
    ];
    const [p] = toDevinPrompts(msgs, "c");
    expect(p.source).toBe(ChatMessageSource.TOOL);
    expect(p.toolCallId).toBe("tu1");
    expect(p.toolResultIsError).toBe(true);
    expect(p.prompt).toBe("result");
  });

  test("tool message isError undefined stays undefined (proto3 omits falsey)", () => {
    const msgs: InternalMessage[] = [{ role: "tool", content: "r", toolCallId: "tu1" }];
    const [p] = toDevinPrompts(msgs, "c");
    expect(p.toolResultIsError).toBeUndefined();
  });

  test("deterministic: same (messages, cascadeId) produces identical messageId sequences", () => {
    const msgs: InternalMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "tool", content: "r", toolCallId: "tu1" },
    ];
    const a = toDevinPrompts(msgs, "cascade-X");
    const b = toDevinPrompts(msgs, "cascade-X");
    expect(a.map((p) => p.messageId)).toEqual(b.map((p) => p.messageId));
  });

  test("different cascadeId produces different messageIds", () => {
    const msgs: InternalMessage[] = [{ role: "user", content: "q" }];
    const a = toDevinPrompts(msgs, "cascade-A");
    const b = toDevinPrompts(msgs, "cascade-B");
    expect(a[0].messageId).not.toBe(b[0].messageId);
  });

  test("assistant messageId prefix differs from user messageId for same index", () => {
    const msgs: InternalMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    const [u, a] = toDevinPrompts(msgs, "c");
    expect(u.messageId.startsWith("bot-")).toBe(false);
    expect(a.messageId.startsWith("bot-")).toBe(true);
  });

  test("tool message messageId incorporates toolCallId (different toolCallId -> different id)", () => {
    const m1: InternalMessage[] = [{ role: "tool", content: "r", toolCallId: "tu1" }];
    const m2: InternalMessage[] = [{ role: "tool", content: "r", toolCallId: "tu2" }];
    expect(toDevinPrompts(m1, "c")[0].messageId).not.toBe(toDevinPrompts(m2, "c")[0].messageId);
  });
});

// ─── openaiToolsToDevin / anthropicToolsToDevin ──────────────────────────────

describe("openaiToolsToDevin", () => {
  test("undefined -> []", () => {
    expect(openaiToolsToDevin(undefined)).toEqual([]);
  });

  test("empty array -> []", () => {
    expect(openaiToolsToDevin([])).toEqual([]);
  });

  test("maps name/description/jsonSchemaString(strict:false) using function.parameters", () => {
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    expect(openaiToolsToDevin(tools)).toEqual([
      {
        name: "get_weather",
        description: "Get weather",
        jsonSchemaString: JSON.stringify({ type: "object", properties: { city: { type: "string" } } }),
        strict: false,
      },
    ]);
  });

  test("missing description defaults to empty string", () => {
    const tools: OpenAITool[] = [{ type: "function", function: { name: "n" } }];
    expect(openaiToolsToDevin(tools)[0].description).toBe("");
  });

  test("missing parameters defaults to {type:object}", () => {
    const tools: OpenAITool[] = [{ type: "function", function: { name: "n", description: "d" } }];
    expect(openaiToolsToDevin(tools)[0].jsonSchemaString).toBe(JSON.stringify({ type: "object" }));
  });
});

describe("anthropicToolsToDevin", () => {
  test("undefined -> []", () => {
    expect(anthropicToolsToDevin(undefined)).toEqual([]);
  });

  test("empty array -> []", () => {
    expect(anthropicToolsToDevin([])).toEqual([]);
  });

  test("maps name/description/jsonSchemaString(strict:false) using input_schema", () => {
    const tools: AnthropicTool[] = [
      { name: "search", description: "Search", input_schema: { type: "object", properties: { q: { type: "string" } } } },
    ];
    expect(anthropicToolsToDevin(tools)).toEqual([
      {
        name: "search",
        description: "Search",
        jsonSchemaString: JSON.stringify({ type: "object", properties: { q: { type: "string" } } }),
        strict: false,
      },
    ]);
  });

  test("missing description defaults to empty string", () => {
    const tools: AnthropicTool[] = [{ name: "n", input_schema: {} }];
    expect(anthropicToolsToDevin(tools)[0].description).toBe("");
  });

  test("missing input_schema defaults to {type:object}", () => {
    const tools: AnthropicTool[] = [{ name: "n", description: "d", input_schema: undefined as unknown as Record<string, unknown> }];
    expect(anthropicToolsToDevin(tools)[0].jsonSchemaString).toBe(JSON.stringify({ type: "object" }));
  });
});

// ─── stopReasonToOpenAI ───────────────────────────────────────────────────────

describe("stopReasonToOpenAI", () => {
  test("hasToolCalls=true returns 'tool_calls' regardless of reason", () => {
    expect(stopReasonToOpenAI(StopReason.STOP, true)).toBe("tool_calls");
    expect(stopReasonToOpenAI(StopReason.MAX_TOKENS, true)).toBe("tool_calls");
    expect(stopReasonToOpenAI(999, true)).toBe("tool_calls");
  });

  test("hasToolCalls=false and MAX_TOKENS returns 'length'", () => {
    expect(stopReasonToOpenAI(StopReason.MAX_TOKENS, false)).toBe("length");
  });

  test("hasToolCalls=false and other reason returns 'stop'", () => {
    expect(stopReasonToOpenAI(StopReason.STOP, false)).toBe("stop");
    expect(stopReasonToOpenAI(0, false)).toBe("stop");
  });
});

// ─── stopReasonToAnthropic ────────────────────────────────────────────────────

describe("stopReasonToAnthropic", () => {
  test("hasToolCalls=true returns 'tool_use' regardless of reason", () => {
    expect(stopReasonToAnthropic(StopReason.STOP, true)).toBe("tool_use");
    expect(stopReasonToAnthropic(StopReason.MAX_TOKENS, true)).toBe("tool_use");
  });

  test("MAX_TOKENS returns 'max_tokens'", () => {
    expect(stopReasonToAnthropic(StopReason.MAX_TOKENS, false)).toBe("max_tokens");
  });

  test("other reason returns 'end_turn'", () => {
    expect(stopReasonToAnthropic(StopReason.STOP, false)).toBe("end_turn");
    expect(stopReasonToAnthropic(0, false)).toBe("end_turn");
  });
});
