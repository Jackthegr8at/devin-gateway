import { describe, expect, test } from "bun:test";

import {
  openaiToInternal,
  anthropicToInternal,
  toDevinPrompts,
  openaiToolsToDevin,
  anthropicToolsToDevin,
  responsesInputToOpenAIMessages,
  CROSS_PROVIDER_COMPACTION_NOTE,
  responsesToolsetToDevin,
  responsesExecutableDeclarations,
  historicalToolsAsInertText,
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

    expect(result.tools[0]).toEqual({
      name: "exec_command",
      description: "Run a local command.",
      jsonSchemaString: JSON.stringify(schema),
      strict: true,
    });
    expect(result.tools.map(tool => tool.name)).toEqual(["exec_command", "get_hostname", "unrelated"]);
    expect(result.identities.get("exec_command")).toEqual({ name: "exec_command" });
    expect(result.identities.has("get_hostname")).toBe(true);
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

  test("forwards function namespaces without silently filtering declared capabilities", () => {
    const result = responsesToolsetToDevin([
      { type: "namespace", name: "other_namespace", tools: [{ type: "function", name: "spawn_agent", parameters: schema }] },
      { type: "function", name: "exec_command", parameters: schema },
    ]);
    expect(result.tools).toHaveLength(2);
    expect(result.identities.get(result.tools[0].name)).toEqual({ namespace: "other_namespace", name: "spawn_agent" });
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
      { type: "function_call", call_id: "c1", name: "", arguments: "{}" },
    ])).toThrow(ResponsesInputError);
    expect(() => responsesToolsetToDevin([
      { type: "function", name: "exec_command", parameters: "not-an-object" },
    ])).toThrow(ResponsesInputError);
  });

  // Synthetic 1x1 PNG (valid signature and IHDR); contains no real screenshot bytes.
  const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const PNG_URL = `data:image/png;base64,${PNG_B64}`;

  test("maps a Codex input_image data URL to a Devin image with text order preserved", () => {
    const messages = responsesInputToOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Look at this " },
          { type: "input_image", image_url: PNG_URL, detail: "auto" },
          { type: "input_text", text: "screenshot." },
        ],
      },
    ]);
    const [prompt] = toDevinPrompts(openaiToInternal(messages), "cascade-image");
    expect(prompt.source).toBe(ChatMessageSource.USER);
    expect(prompt.prompt).toBe("Look at this screenshot.");
    expect(prompt.images).toEqual([{ mimeType: "image/png", base64Data: PNG_B64 }]);
  });
  test("keeps an image from earlier conversation history on its own user turn", () => {
    const messages = responsesInputToOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "input_text", text: "First look" },
          { type: "input_image", image_url: PNG_URL },
        ],
      },
      { role: "assistant", content: [{ type: "output_text", text: "I see a blank image." }] },
      { role: "user", content: [{ type: "input_text", text: "Follow up without an image" }] },
    ]);
    const prompts = toDevinPrompts(openaiToInternal(messages), "cascade-history");
    expect(prompts.map((p) => p.prompt)).toEqual(["First look", "I see a blank image.", "Follow up without an image"]);
    expect(prompts[0].images).toEqual([{ mimeType: "image/png", base64Data: PNG_B64 }]);
    expect(prompts[1].images ?? []).toEqual([]);
    expect(prompts[2].images ?? []).toEqual([]);
  });

  test("rejects remote, non-image, and malformed input_image parts instead of dropping them", () => {
    expect(() => responsesInputToOpenAIMessages([
      { role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] },
    ])).toThrow(ResponsesInputError);
    expect(() => responsesInputToOpenAIMessages([
      { role: "user", content: [{ type: "input_image", image_url: "data:image/svg+xml;base64,PHN2Zz4=" }] },
    ])).toThrow(ResponsesInputError);
    expect(() => responsesInputToOpenAIMessages([
      { role: "user", content: [{ type: "input_image" }] },
    ])).toThrow(ResponsesInputError);
    expect(() => responsesInputToOpenAIMessages([
      { role: "assistant", content: [{ type: "input_image", image_url: PNG_URL }] },
    ])).toThrow(ResponsesInputError);
  });

  test("text-only Responses content is unchanged and carries no images field", () => {
    const messages = responsesInputToOpenAIMessages([
      { role: "user", content: [{ type: "input_text", text: "a" }, { type: "text", text: "b" }] },
      { role: "assistant", content: "plain" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "ab" },
      { role: "assistant", content: "plain" },
    ]);
    expect("images" in messages[0]).toBe(false);
  });

  // Shape copied from a real Codex Desktop replacement_history entry: an
  // additional_tools item holding namespace groups, with function and custom children.
  const additionalToolsItem = (...tools: unknown[]) => ({
    type: "additional_tools",
    id: "at_test",
    role: "developer",
    tools,
  });
  const multiAgentNamespace = {
    type: "namespace",
    name: "multi_agent_v1",
    tools: ["spawn_agent", "send_input"].map((name) => ({ type: "function", name, parameters: schema })),
  };

  test("skips additional_tools items in history without rejecting the conversation", () => {
    const messages = responsesInputToOpenAIMessages([
      additionalToolsItem({ type: "namespace", name: "functions", tools: [] }),
      { role: "user", content: [{ type: "input_text", text: "Continue on the other model" }] },
      { type: "function_call", call_id: "c1", name: "exec_command", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "c1", output: "/work" },
      { role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "Continue on the other model" },
      {
        role: "assistant", content: "", tool_calls: [{
          id: "c1", type: "function", function: { name: "exec_command", arguments: '{"cmd":"pwd"}' },
        }],
      },
      { role: "tool", tool_call_id: "c1", content: "/work" },
      { role: "assistant", content: "Done." },
    ]);
  });

  test("declares tools supplied only through additional_tools", () => {
    const result = responsesToolsetToDevin([additionalToolsItem(multiAgentNamespace)]);
    expect(result.tools.map((tool) => tool.name)).toEqual(["multi_agent_v1__spawn_agent", "multi_agent_v1__send_input"]);
    expect(result.identities.get("multi_agent_v1__spawn_agent")).toEqual({ namespace: "multi_agent_v1", name: "spawn_agent" });
  });

  test("a duplicated conversation with tools only in its history declares them once", () => {
    // Mirrors the server: top-level tools plus additional_tools items found in input.
    const input = [
      additionalToolsItem(multiAgentNamespace),
      { role: "user", content: [{ type: "input_text", text: "Keep going" }] },
    ];
    const topLevel: unknown[] = [];
    const toolset = responsesToolsetToDevin([
      ...topLevel,
      ...input.filter((item) => (item as { type?: string }).type === "additional_tools"),
    ]);
    expect(toolset.tools.map((tool) => tool.name)).toEqual(["multi_agent_v1__spawn_agent", "multi_agent_v1__send_input"]);
    expect(responsesInputToOpenAIMessages(input)).toEqual([{ role: "user", content: "Keep going" }]);
  });

  test("does not duplicate a tool declared in both top-level tools and additional_tools", () => {
    const declared = [{ type: "function", name: "exec_command", description: "Run", parameters: schema }];
    const result = responsesToolsetToDevin([
      ...declared,
      additionalToolsItem({ type: "function", name: "exec_command", description: "Run", parameters: schema }),
    ]);
    expect(result.tools.map((tool) => tool.name)).toEqual(["exec_command"]);
  });

  test("still rejects an additional_tools declaration that conflicts with a top-level one", () => {
    expect(() => responsesToolsetToDevin([
      { type: "function", name: "exec_command", description: "Run", parameters: schema },
      additionalToolsItem({ type: "function", name: "exec_command", description: "Different", parameters: schema }),
    ])).toThrow(ResponsesInputError);
  });

  test("Sol to SWE duplicated collaboration declarations ignore object key order", () => {
    const current = { type: "function", name: "spawn_agent", description: "Spawn", strict: false,
      parameters: { type: "object", properties: { message: { type: "string", description: "Task" } }, required: ["message"] } };
    const historical = { ...current, parameters: { required: ["message"], properties: { message: { description: "Task", type: "string" } }, type: "object" } };
    const group = (tool: unknown) => ({ type: "namespace", name: "collaboration", tools: [tool] });
    const result = responsesToolsetToDevin([group(current), additionalToolsItem(group(historical)), additionalToolsItem(group(historical))]);
    expect(result.tools).toHaveLength(1);
    expect(result.identities.get(result.tools[0].name)).toEqual({ namespace: "collaboration", name: "spawn_agent" });
  });

  test("preserves multi-agent V2 identity and approval schema extensions", () => {
    const declaration = { type: "function", name: "spawn_agent", parameters: schema, requires_approval: true };
    const group = { type: "namespace", name: "multi_agent_v2", tools: [declaration] };
    const result = responsesToolsetToDevin([group, additionalToolsItem(group)]);
    expect(result.tools).toHaveLength(1);
    expect(result.identities.get(result.tools[0].name)).toEqual({ namespace: "multi_agent_v2", name: "spawn_agent" });
    expect(() => responsesToolsetToDevin([group, additionalToolsItem({ ...group, tools: [{ ...declaration, requires_approval: false }] })])).toThrow(ResponsesInputError);
  });
  test("conflicting collaboration schemas identify both sources without exposing values", () => {
    const group = (type: string) => ({ type: "namespace", name: "collaboration", tools: [{
      type: "function", name: "spawn_agent", parameters: { type: "object", properties: { message: { type } } },
    }] });
    expect(() => responsesToolsetToDevin([group("string"), additionalToolsItem(group("number"))]))
      .toThrow(/tools\[0\].*sha256=.*additional_tools\[1\].*sha256=.*precedence is unverified/);
    expect(() => responsesToolsetToDevin([group("string"), group("number")])).toThrow(ResponsesInputError);
    expect(() => responsesToolsetToDevin([additionalToolsItem(group("string")), additionalToolsItem(group("number"))])).toThrow(ResponsesInputError);
  });

  test("still rejects unknown input item types", () => {
    expect(() => responsesInputToOpenAIMessages([{ type: "mystery_item" }])).toThrow(ResponsesInputError);
  });

  test("preserves mixed foreign function and raw custom history without declaring executable tools", () => {
    const raw = 'not JSON\nconsole.log("synthetic");\n';
    const parts = [{ type: "input_text", text: "first\n" }, { type: "input_text", text: "second" }];
    const messages = responsesInputToOpenAIMessages([
      { role: "developer", content: "Synthetic instructions" },
      { type: "additional_tools", tools: [{ type: "custom", name: "exec" }] },
      { type: "custom_tool_call", id: "item-a", call_id: "call-a", name: "exec", input: raw },
      { type: "custom_tool_call_output", call_id: "call-a", output: parts },
      { type: "function_call", call_id: "call-b", name: "curr_time", namespace: "clock", arguments: "{}" },
      { type: "function_call_output", call_id: "call-b", output: "synthetic time" },
      { role: "user", content: "Continue" },
    ]);
    const internal = openaiToInternal(messages);
    expect(messages.map((m) => m.role)).toEqual(["developer", "assistant", "tool", "assistant", "tool", "user"]);
    expect(internal[1].toolCalls).toEqual([{ id: "call-a", name: "exec", arguments: { input: raw } }]);
    expect(JSON.parse(internal[2].content)).toEqual(parts);
    expect(internal[2].toolCallId).toBe("call-a");
    expect(internal[3].toolCalls).toEqual([{ id: "call-b", name: "clock.curr_time", arguments: {} }]);
    expect(internal[4]).toMatchObject({ role: "tool", toolCallId: "call-b", content: "synthetic time" });
    expect(() => responsesToolsetToDevin([{ type: "custom", name: "exec" }])).toThrow(ResponsesInputError);
  });

  test("custom history supports empty raw input, namespace and string outputs", () => {
    const messages = responsesInputToOpenAIMessages([
      { type: "custom_tool_call", call_id: "c", namespace: "functions", name: "exec", input: "" },
      { type: "custom_tool_call_output", call_id: "c", output: "" },
    ]);
    expect(messages[0].tool_calls?.[0]).toEqual({ id: "c", type: "function", function: { name: "functions.exec", arguments: '{"input":""}' } });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "c", content: "" });
  });

  test("rejects malformed custom history and non-text outputs without dropping data", () => {
    for (const item of [
      { type: "custom_tool_call", call_id: "c", name: "exec", input: {} },
      { type: "custom_tool_call", call_id: "", name: "exec", input: "raw" },
      { type: "custom_tool_call", call_id: "c", name: "exec", namespace: 7, input: "raw" },
      { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_text" }] },
      { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_image", image_url: "synthetic" }] },
      { type: "custom_tool_call_output", call_id: "c", output: { text: "synthetic" } },
    ]) expect(() => responsesInputToOpenAIMessages([item])).toThrow(ResponsesInputError);
  });

  test("opt-in compaction skip drops only the opaque item, keeps order and adds one notice", () => {
    const messages = responsesInputToOpenAIMessages([
      { role: "user", content: "Before" },
      { type: "compaction", encrypted_content: "SYNTHETIC_OPAQUE_PAYLOAD" },
      { type: "compaction", encrypted_content: "SYNTHETIC_OPAQUE_PAYLOAD_2" },
      { role: "assistant", content: "After" },
      { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_1", output: "/tmp" },
    ], { skipCompaction: true });
    expect(messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "assistant", "tool"]);
    expect(messages[0]).toEqual({ role: "user", content: "Before" });
    expect(messages[1]).toEqual({ role: "user", content: CROSS_PROVIDER_COMPACTION_NOTE });
    expect(messages[2]).toEqual({ role: "assistant", content: "After" });
    expect(JSON.stringify(messages)).not.toContain("SYNTHETIC_OPAQUE_PAYLOAD");
  });

  test("opt-in compaction skip still rejects other unsupported item types", () => {
    expect(() => responsesInputToOpenAIMessages([
      { type: "compaction", encrypted_content: "SYNTHETIC_OPAQUE_PAYLOAD" },
      { type: "mystery_item" },
    ], { skipCompaction: true })).toThrow(ResponsesInputError);
  });
  test("opaque compaction fails before partial history conversion and never exposes the payload", () => {
    const secret = "SYNTHETIC_OPAQUE_PAYLOAD";
    try {
      responsesInputToOpenAIMessages([
        { type: "mystery_item" },
        { type: "compaction", encrypted_content: secret, summary: "Untrusted visible fragment" },
      ]);
      throw new Error("Compaction must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ResponsesInputError);
      expect((error as Error).message).toContain("compaction at index 1");
      expect((error as Error).message).toContain("visible text handoff");
      expect((error as Error).message).not.toContain(secret);
    }
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

 test("duplicate diagnostics distinguish exact, reordered and conflicting declarations", () => {
  const events: any[] = [];
  const tool = { type: "function", name: "spawn_agent", description: "Synthetic private prose", parameters: { type: "object", properties: { task: { type: "string" } } } };
  const group = (t: unknown) => ({ type: "namespace", name: "collaboration", tools: [t] });
  const reordered = { ...tool, parameters: { properties: { task: { type: "string" } }, type: "object" } };
  responsesToolsetToDevin([group(tool), { type: "additional_tools", tools: [group(tool), group(reordered)] }], undefined, e => events.push(e));
  expect(() => responsesToolsetToDevin([group(tool), group({ ...tool, strict: true })], undefined, e => events.push(e))).toThrow(ResponsesInputError);
  expect(events.map(e => e.outcome)).toEqual(["identical", "key_order_equivalent", "conflicting"]);
  expect(events[0].first).toMatchObject({ container: "tools", index: 0 });
  expect(events[0].second).toMatchObject({ container: "additional_tools", index: 1 });
  expect(events[1].first.structural_hash).toBe(events[1].second.structural_hash);
  expect(events[2].first.structural_hash).not.toBe(events[2].second.structural_hash);
  expect(JSON.stringify(events)).not.toContain("Synthetic private prose");
  expect(JSON.stringify(events)).not.toContain("parameters");
 });

test("cross-history conflicts report bounded field paths without client values", () => {
 const events: any[] = [];
 const tool = { type: "function", name: "spawn_agent", description: "private-description-a", parameters: { type: "object", properties: { "private-field-name": { type: "string" } }, required: ["private-field-name"] }, strict: false };
 const changed = { ...tool, description: "private-description-b", strict: true, parameters: { ...tool.parameters, required: [], properties: { "private-field-name": { type: "number" } } }, privateMetadata: "private-value" };
 const group = (t: unknown) => ({ type: "namespace", name: "collaboration", tools: [t] });
 expect(() => responsesToolsetToDevin([group(tool), { type: "additional_tools", tools: [group(changed)] }], undefined, e => events.push(e))).toThrow(ResponsesInputError);
 const comparison = events[0].comparison;
 expect(comparison.truncated).toBe(false);
 expect(new Set(comparison.differences.map((d: any) => d.category))).toEqual(new Set(["description", "parameters", "required", "strictness", "metadata"]));
 expect(comparison.differences.some((d: any) => d.path.startsWith("/parameters/properties/key-sha256-") && d.path.endsWith("/type"))).toBe(true);
 expect(JSON.stringify(events)).not.toContain("private-");
 expect(JSON.stringify(events)).not.toContain("privateMetadata");
 const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["field" + i, i]));
 expect(() => responsesToolsetToDevin([group(tool), group({ ...tool, ...many })], undefined, e => events.push(e))).toThrow(ResponsesInputError);
 expect(events[1].comparison.differences).toHaveLength(32);
 expect(events[1].comparison.truncated).toBe(true);
});

describe("request catalog provenance", () => {
 const group = (agentType: boolean) => ({ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", description: agentType ? "Current" : "Old", parameters: { type: "object", properties: agentType ? { agent_type: { type: "string" } } : {}, additionalProperties: false } }] });
 const old = { type: "additional_tools", role: "developer", tools: [group(false)] };
 test("duplicated Sol to SWE request retains current agent_type schema", () => {
  const current = [group(true)]; const input = [old, { role: "user", content: "Continue" }];
  const result = responsesToolsetToDevin(responsesExecutableDeclarations(current, input));
  expect(JSON.parse(result.tools[0].jsonSchemaString).properties.agent_type).toEqual({ type: "string" });
  expect(result.identities.get(result.tools[0].name)).toEqual({ namespace: "collaboration", name: "spawn_agent" });
  expect(current).toEqual([group(true)]);
 });
 test("Lite uses only its leading developer catalog", () => {
  const result = responsesToolsetToDevin(responsesExecutableDeclarations(undefined, [{ ...old, tools: [group(true)] }, old]));
  expect(result.tools).toHaveLength(1);
  expect(JSON.parse(result.tools[0].jsonSchemaString).properties.agent_type).toBeDefined();
  expect(responsesExecutableDeclarations([], [old])).toEqual([]);
  expect(responsesExecutableDeclarations(undefined, [{ role: "user", content: "History" }, old])).toBeUndefined();
  expect(responsesExecutableDeclarations(undefined, [{ ...old, role: "user" }])).toBeUndefined();
 });
 test("selected catalog conflicts and malformed catalogs still fail", () => {
  expect(() => responsesToolsetToDevin(responsesExecutableDeclarations([group(true), group(false)], [old]))).toThrow(ResponsesInputError);
  expect(() => responsesExecutableDeclarations(null, [old])).toThrow(ResponsesInputError);
  expect(() => responsesExecutableDeclarations(undefined, [{ ...old, tools: null }])).toThrow(ResponsesInputError);
 });
 test("obsolete capabilities remain inert with call IDs and chronology", () => {
  const input = [old,
   { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "old-id", arguments: '{}' },
   { type: "function_call_output", call_id: "old-id", output: "Synthetic result" },
   { role: "user", content: "Continue" }];
  const selected = responsesToolsetToDevin(responsesExecutableDeclarations([], input));
  const history = historicalToolsAsInertText(responsesInputToOpenAIMessages(input), selected.identities);
  expect(selected.tools).toEqual([]);
  expect(history).toHaveLength(3);
  expect(history[0].tool_calls).toBeUndefined();
  expect(history[0].content).toContain('"call_id":"old-id"');
  expect(history[1].content).toContain('"call_id":"old-id"');
  expect(history[1].content).toContain("Synthetic result");
  expect(history[2].content).toBe("Continue");
 });
 test("tool_search output does not silently authorize a declaration", () => {
  expect(() => responsesInputToOpenAIMessages([{ type: "tool_search_output", call_id: "search", tools: [group(true)] }])).toThrow(ResponsesInputError);
 });
});

test("standard and Lite retain current MCP, V2 and shell catalogs", () => {
 const parameters = { type: "object", properties: {} };
 const catalog = [
  { type: "function", name: "exec_command", parameters },
  { type: "function", name: "write_stdin", parameters },
  { type: "namespace", name: "mcp__memory", tools: [{ type: "function", name: "recall", parameters }] },
  { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", parameters }] },
 ];
 const old = { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "obsolete", parameters }] };
 for (const [tools, input] of [[catalog, [old]], [undefined, [{ type: "additional_tools", role: "developer", tools: catalog }, old]]] as const) {
  const result = responsesToolsetToDevin(responsesExecutableDeclarations(tools, input));
  expect(result.tools).toHaveLength(4);
  expect([...result.identities.values()]).toEqual([{ name: "exec_command" }, { name: "write_stdin" }, { namespace: "mcp__memory", name: "recall" }, { namespace: "collaboration", name: "spawn_agent" }]);
  expect([...result.identities.values()].some(x => x.name === "obsolete")).toBe(false);
 }
});
