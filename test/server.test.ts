import { expect, test, describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { startServer } from "../src/server.ts";
import { listModels } from "../src/models.ts";
import { ProtoDecoder } from "../src/proto.ts";
import { familyFixture, familyPayload } from "./fixtures/model-families.ts";
import { incomingCatalog } from "./fixtures/tool-catalog.ts";
import { responsesToolsetToDevin } from "../src/convert.ts";

const HOST = "127.0.0.1";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";

// ─── protobuf encoders (mirror test/models-source-selection.test.ts) ─────────

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return bytes;
}

function encodeTag(field: number, wire: number): number[] {
  return encodeVarint((field << 3) | wire);
}

function encodeString(field: number, value: string): number[] {
  const payload = new TextEncoder().encode(value);
  return [...encodeTag(field, 2), ...encodeVarint(payload.length), ...payload];
}

function encodeUint32(field: number, value: number): number[] {
  return [...encodeTag(field, 0), ...encodeVarint(value)];
}

function encodeMessage(field: number, payload: number[]): number[] {
  return [...encodeTag(field, 2), ...encodeVarint(payload.length), ...payload];
}

// ─── Connect frame + response builders ───────────────────────────────────────

function connectFrame(flag: number, payload: Uint8Array): Uint8Array {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

interface ToolCallFields {
  id: string;
  name: string;
  argumentsJson: string;
}

interface ChatResponseFields {
  text?: string;
  thinking?: string;
  toolCalls?: ToolCallFields[];
  stopReason?: number;
  usage?: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };
}

/** Build a GetChatMessageResponse protobuf payload. */
function chatResponsePayload(fields: ChatResponseFields): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...encodeString(1, "msg-fixture")); // messageId
  if (fields.text) bytes.push(...encodeString(3, fields.text));
  if (fields.stopReason) bytes.push(...encodeUint32(5, fields.stopReason));
  for (const tc of fields.toolCalls ?? []) {
    bytes.push(
      ...encodeMessage(6, [
        ...encodeString(1, tc.id),
        ...encodeString(2, tc.name),
        ...encodeString(3, tc.argumentsJson),
      ]),
    );
  }
  if (fields.usage) {
    bytes.push(
      ...encodeMessage(7, [
        ...encodeUint32(2, fields.usage.inputTokens),
        ...encodeUint32(3, fields.usage.outputTokens),
        ...(fields.usage.cacheWriteTokens ? encodeUint32(4, fields.usage.cacheWriteTokens) : []),
        ...(fields.usage.cacheReadTokens ? encodeUint32(5, fields.usage.cacheReadTokens) : []),
      ]),
    );
  }
  if (fields.thinking) bytes.push(...encodeString(9, fields.thinking));
  return Uint8Array.from(bytes);
}

/** Concatenate data frames + an end-stream trailer (optionally carrying a Connect error). */
function framesBody(
  dataFrames: Uint8Array[],
  trailer?: { error?: { code: string; message: string } },
): Uint8Array {
  const parts = [...dataFrames];
  if (trailer?.error) {
    const json = JSON.stringify({ error: trailer.error });
    parts.push(connectFrame(0x02, new TextEncoder().encode(json)));
  } else {
    parts.push(connectFrame(0x02, new Uint8Array(0)));
  }
  return Buffer.concat(parts);
}

function dataFrame(fields: ChatResponseFields): Uint8Array {
  return connectFrame(0x00, chatResponsePayload(fields));
}

/** Default chat body: one frame with text "hi" + usage, then end-stream trailer. */
function defaultChatBody(): Uint8Array {
  return framesBody([
    dataFrame({ text: "hi", usage: { inputTokens: 10, outputTokens: 5 } }),
  ]);
}

/** Decode the `prompt` (systemPrompt, field 2) from a Connect-framed, gzipped GetChatMessageRequest. */
function decodeChatRequestPrompt(body: Uint8Array): string {
  const flag = body[0];
  const len = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
  const payload = body.subarray(5, 5 + len);
  const raw = flag & 0x01 ? gunzipSync(payload) : payload;
  const d = new ProtoDecoder(raw);
  let prompt = "";
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 2 && wire === 2) prompt = d.readString();
    else d.skip(wire);
  }
  return prompt;
}

/** Decode the `toolChoice` (field 12) from a Connect-framed, gzipped GetChatMessageRequest. */
function decodeChatRequestToolChoice(body: Uint8Array): { optionName?: string; toolName?: string } | undefined {
  const flag = body[0];
  const len = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
  const payload = body.subarray(5, 5 + len);
  const raw = flag & 0x01 ? gunzipSync(payload) : payload;
  const d = new ProtoDecoder(raw);
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 12 && wire === 2) {
      return d.readMessage((sub) => {
        let optionName: string | undefined;
        let toolName: string | undefined;
        while (!sub.done) {
          const { field: f, wire: w } = sub.readTag();
          if (f === 1 && w === 2) optionName = sub.readString();
          else if (f === 2 && w === 2) toolName = sub.readString();
          else sub.skip(w);
        }
        return { optionName, toolName };
      });
    }
    d.skip(wire);
  }
  return undefined;
}

function decodeChatRequest(body: Uint8Array): {
  prompt: string;
  modelUid: string;
  disableParallelToolCalls?: boolean;
  prompts: Array<{ source?: number; prompt?: string; toolCallId?: string; toolCalls: Array<{ id: string; name: string; argumentsJson: string }> }>;
  tools: Array<{ name: string; description: string; schema: string; strict: boolean }>;
} {
  const flag = body[0];
  const len = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
  const payload = body.subarray(5, 5 + len);
  const raw = flag & 0x01 ? gunzipSync(payload) : payload;
  const d = new ProtoDecoder(raw);
  const result = { prompt: "", modelUid: "", prompts: [], tools: [] } as ReturnType<typeof decodeChatRequest>;
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 11 && wire === 0) result.disableParallelToolCalls = d.readVarint() !== 0n;
    else if (field === 2 && wire === 2) result.prompt = d.readString();
    else if (field === 3 && wire === 2) {
      result.prompts.push(d.readMessage((sub) => {
        const item: ReturnType<typeof decodeChatRequest>["prompts"][number] = { toolCalls: [] };
        while (!sub.done) {
          const { field: f, wire: w } = sub.readTag();
          if (f === 2 && w === 0) item.source = Number(sub.readVarint());
          else if (f === 3 && w === 2) item.prompt = sub.readString();
          else if (f === 6 && w === 2) {
            item.toolCalls.push(sub.readMessage((call) => {
              const value = { id: "", name: "", argumentsJson: "" };
              while (!call.done) {
                const { field: cf, wire: cw } = call.readTag();
                if (cf === 1 && cw === 2) value.id = call.readString();
                else if (cf === 2 && cw === 2) value.name = call.readString();
                else if (cf === 3 && cw === 2) value.argumentsJson = call.readString();
                else call.skip(cw);
              }
              return value;
            }));
          } else if (f === 7 && w === 2) item.toolCallId = sub.readString();
          else sub.skip(w);
        }
        return item;
      }));
    } else if (field === 10 && wire === 2) {
      result.tools.push(d.readMessage((sub) => {
        const tool = { name: "", description: "", schema: "", strict: false };
        while (!sub.done) {
          const { field: f, wire: w } = sub.readTag();
          if (f === 1 && w === 2) tool.name = sub.readString();
          else if (f === 2 && w === 2) tool.description = sub.readString();
          else if (f === 3 && w === 2) tool.schema = sub.readString();
          else if (f === 12 && w === 0) tool.strict = sub.readVarint() !== 0n;
          else sub.skip(w);
        }
        return tool;
      }));
    } else if (field === 21 && wire === 2) result.modelUid = d.readString();
    else d.skip(wire);
  }
  return result;
}

// ─── Upstream mock (fake Devin API) ──────────────────────────────────────────

interface UpstreamOptions {
  modelsBody?: Uint8Array;
  /** Build the GetChatMessage response body. Defaults to a single "hi" frame. */
  chatBody?: () => Uint8Array;
  /** Return a non-ok Response for GetChatMessage instead of a frame stream. */
  chatError?: { status: number; body: string };
  /** Capture the raw GetChatMessage request body (Connect frame). */
  captureChatRequest?: (body: Uint8Array) => void;
  /** JWT returned by GetUserJwt. Default "jwt". */
  jwt?: string;
}

interface Upstream {
  url: string;
  stop: () => Promise<void>;
}

function startUpstream(opts: UpstreamOptions = {}): Upstream {
  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/GetCliModelConfigs") && opts.modelsBody) return new Response(opts.modelsBody);
      if (url.pathname === DEVIN_AUTH_PATH) {
        const payload = Uint8Array.from([
          ...encodeString(1, opts.jwt ?? "jwt"), // userJwt
        ]);
        return new Response(payload, { headers: { "content-type": "application/proto" } });
      }
      if (url.pathname === CHAT_MESSAGE_PATH) {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (opts.captureChatRequest) opts.captureChatRequest(buf);
        if (opts.chatError) {
          return new Response(opts.chatError.body, { status: opts.chatError.status });
        }
        const body = opts.chatBody ? opts.chatBody() : defaultChatBody();
        return new Response(body, {
          headers: { "content-type": "application/connect+proto" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: server.url, stop: () => server.stop() };
}

// ─── Gateway harness with SIGTERM/SIGINT listener cleanup ────────────────────

async function reservePort(): Promise<number> {
  const probe = Bun.serve({ hostname: HOST, port: 0, fetch: () => new Response(null) });
  const port = probe.port;
  await probe.stop();
  return port;
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

interface Gateway {
  url: string;
  cleanup: () => Promise<void>;
}

async function startGateway(upstreamUrl: string, token?: string, modelSelection?: { directory: string }): Promise<Gateway> {
  const port = await reservePort();
  const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
  const handle = await startServer({
    host: HOST,
    port,
    token,
    baseUrl: upstreamUrl,
    modelSelection,
  });
  const url = `http://${HOST}:${port}`;
  const cleanup = async () => {
    try {
      await handle.stop();
    } finally {
      for (const s of SIGNALS) {
        const prev = before.get(s)!;
        for (const l of process.listeners(s)) {
          if (!prev.has(l)) process.removeListener(s, l);
        }
      }
    }
  };
  return { url, cleanup };
}

// ─── SSE parsing helpers ─────────────────────────────────────────────────────

interface SseEvent {
  event: string | null;
  data: string;
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | null = null;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    events.push({ event, data });
  }
  return events;
}

// ─── /health ─────────────────────────────────────────────────────────────────

describe("/health", () => {
  test("returns not_set when no fallback token is configured", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        status: "ok",
        fallback_token: "not_set",
        collapse_system_enabled: process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM === "1",
      });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("returns set when a fallback token is configured", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "fallback-key");
    try {
      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        status: "ok",
        fallback_token: "set",
        collapse_system_enabled: process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM === "1",
      });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
  test("reports collapse enabled only when the explicit environment flag is set", async () => {
    const originalFlag = process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM;
    process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM = "1";
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ok",
        fallback_token: "not_set",
        collapse_system_enabled: true,
      });
    } finally {
      await cleanup();
      await upstream.stop();
      if (originalFlag === undefined) delete process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM;
      else process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM = originalFlag;
    }
  });
});

// ─── Auth (extractToken) ─────────────────────────────────────────────────────

describe("auth — extractToken", () => {
  test("rejects chat completions with no token via 401 authentication_error", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.type).toBe("authentication_error");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("accepts Authorization: Bearer <token>", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer my-token",
        },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("accepts x-api-key header", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "my-token",
        },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("accepts a bare Authorization header (no Bearer prefix)", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "my-token",
        },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("uses the configured fallback token when no header is sent", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "fallback-key");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── Routing 404 + CORS ──────────────────────────────────────────────────────

describe("routing 404 + CORS", () => {
  test("unknown path returns 404 invalid_request_error with Not found message", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/unknown`);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.message).toContain("Not found");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("OPTIONS preflight returns 204 with CORS headers", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "OPTIONS",
        headers: { origin: "https://example.com" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
      expect(res.headers.get("access-control-allow-headers")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("*");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("GET /health with Origin echoes CORS allow-origin", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    try {
      const res = await fetch(`${url}/health`, { headers: { origin: "https://app.test" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── POST /v1/chat/completions (non-streaming) ───────────────────────────────

describe("POST /v1/chat/completions (non-streaming)", () => {
  test("aggregates a text response with usage and stop finish_reason", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.content).toBe("hi");
      expect(body.choices[0].finish_reason).toBe("stop");
      expect(body.usage.prompt_tokens).toBe(10);
      expect(body.usage.completion_tokens).toBe(5);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("cache tokens propagate to prompt_tokens_details.cached_tokens", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([
          dataFrame({ text: "hi", usage: { inputTokens: 10, outputTokens: 5, cacheWriteTokens: 2, cacheReadTokens: 4 } }),
        ]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage.prompt_tokens).toBe(10);
      expect(body.usage.prompt_tokens_details.cached_tokens).toBe(4);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("maps tool calls to tool_calls with content null and tool_calls finish_reason", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([
          dataFrame({
            text: "calling tool",
            toolCalls: [
              {
                id: "call_1",
                name: "get_weather",
                argumentsJson: '{"city":"SF"}',
              },
            ],
          }),
        ]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "weather?" }] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.choices[0].message.content).toBeNull();
      expect(body.choices[0].message.tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
      ]);
      expect(body.choices[0].finish_reason).toBe("tool_calls");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("streamChat error event maps to 502", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody(
          [dataFrame({ text: "hi" })],
          { error: { code: "internal", message: "boom" } },
        ),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).not.toContain("boom");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("upstream HTTP 500 maps to 502", async () => {
    const upstream = startUpstream({
      chatError: { status: 500, body: "upstream broken" },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain("500");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── POST /v1/chat/completions (streaming) ───────────────────────────────────

describe("POST /v1/chat/completions stream=true", () => {
  test("emits role chunk, content deltas, finish_reason, then [DONE]", async () => {
    const upstream = startUpstream({
      chatBody: () => framesBody([dataFrame({ text: "hel" }), dataFrame({ text: "lo" })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const text = await res.text();
      const events = parseSse(text);
      const datas = events.map((e) => e.data);

      // last data is [DONE]
      expect(datas[datas.length - 1]).toBe("[DONE]");

      // first chunk carries role:assistant
      const first = JSON.parse(datas[0]);
      expect(first.choices[0].delta.role).toBe("assistant");
      expect(first.choices[0].finish_reason).toBeNull();

      // middle chunks carry content deltas
      const contentChunks = datas
        .slice(1, -2)
        .map((d) => JSON.parse(d))
        .filter((c) => c.choices?.[0]?.delta?.content);
      expect(contentChunks.map((c) => c.choices[0].delta.content).join("")).toBe("hello");

      // penultimate chunk carries finish_reason
      const penultimate = JSON.parse(datas[datas.length - 2]);
      expect(penultimate.choices[0].finish_reason).toBe("stop");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── POST /v1/responses ──────────────────────────────────────────────────────

describe("POST /v1/responses (non-streaming)", () => {
  test("safe diagnostics write only allowlisted metadata and suppress legacy error traces", async () => {
    const directory = mkdtempSync(join(tmpdir(), "devin-responses-server-diagnostic-"));
    const diagnosticPath = join(directory, "responses-safe-diagnostic.jsonl");
    const errorTracePath = join(directory, "errors");
    const environment = [
      "DEVIN_RESPONSES_SAFE_DIAGNOSTICS",
      "DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH",
      "ERROR_TRACE_DIR",
    ] as const;
    const previousEnvironment = new Map(environment.map((key) => [key, process.env[key]]));
    const prompt = "SYNTHETIC_USER_PROMPT_NOT_FOR_LOGGING_6d2";
    const instruction = "SYNTHETIC_SYSTEM_INSTRUCTION_NOT_FOR_LOGGING_2a9";
    const token = "SYNTHETIC_AUTH_TOKEN_NOT_FOR_LOGGING_a82";
    const cookie = "SYNTHETIC_COOKIE_NOT_FOR_LOGGING_c14";
    const description = "SYNTHETIC_TOOL_DESCRIPTION_NOT_FOR_LOGGING_913";
    const schemaMarker = "SYNTHETIC_SCHEMA_NOT_FOR_LOGGING_2dd";
    const trailerMessage = `MCP configuration issue ${prompt} ${token} ${cookie}`;
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1";
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = diagnosticPath;
    process.env.ERROR_TRACE_DIR = errorTracePath;
    const upstream = startUpstream({
      chatBody: () => framesBody([], { error: { code: "permission_denied", message: trailerMessage } }),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "");
    const previousConsoleError = console.error;
    const consoleLines: string[] = [];
    console.error = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")); };
    try {
      const request = async (stream: boolean): Promise<Response> => fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          cookie,
        },
        body: JSON.stringify({
          model: "glm-5-3-flash-low",
          instructions: instruction,
          input: [{ role: "user", content: prompt }],
          stream,
          tools: [{
            type: "function",
            name: "exec_command",
            description,
            parameters: { type: "object", properties: { marker: { type: "string", description: schemaMarker } } },
          }],
        }),
      });
      const nonStreamingResponse = await request(false);
      expect(nonStreamingResponse.status).toBe(502);
      const streamingResponse = await request(true);
      expect(streamingResponse.status).toBe(200);
      expect(await streamingResponse.text()).toContain("event: response.failed");

      const serialized = readFileSync(diagnosticPath, "utf8");
      for (const secret of [prompt, instruction, token, cookie, description, schemaMarker, trailerMessage]) {
        expect(serialized).not.toContain(secret);
        expect(consoleLines.join("\n")).not.toContain(secret);
      }
      expect(existsSync(errorTracePath)).toBe(false);
      const records = serialized.trim().split(/\r?\n/).map((line) => JSON.parse(line));
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.response_failed_source)).toEqual([
        "gateway_responses_nonstream_catch",
        "gateway_responses_stream_catch",
      ]);
      for (const record of records) {
        expect(record).toMatchObject({
          model_id: "glm-5-3-flash-low",
          connect_error_code: "permission_denied",
          connect_error_message: "MCP configuration issue",
          failure_classification: "devin_policy_denial",
        });
        expect(record.instruction_byte_length).toBe(Buffer.byteLength(instruction, "utf8"));
        expect(record.user_input_byte_length).toBe(Buffer.byteLength(prompt, "utf8"));
        expect(record.forwarded_tool_fingerprints[0].description_sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(record.forwarded_tool_fingerprints[0].schema_sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally {
      console.error = previousConsoleError;
      await cleanup();
      await upstream.stop();
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("accepts string input and returns completed response with output_text", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", input: "Hello" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.object).toBe("response");
      expect(body.status).toBe("completed");
      expect(body.output[0].content[0].text).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("accepts array input and returns completed response", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: [{ role: "user", content: "Hello" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("completed");
      expect(body.output[0].content[0].text).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("prepends instructions as a developer message that reaches the upstream systemPrompt", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => {
        captured = b;
      },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          input: "Hello",
          instructions: "Be concise.",
        }),
      });
      expect(res.status).toBe(200);
      expect(captured).toBeDefined();
      expect(decodeChatRequestPrompt(captured!)).toContain("Be concise.");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("returns a Devin tool call with its real call ID and safe Responses output item", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (body) => { captured = body; },
      chatBody: () => framesBody([dataFrame({
        toolCalls: [{ id: "devin-call-001", name: "exec_command", argumentsJson: '{"cmd":"hostname"}' }],
        stopReason: 10,
      })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    const schema = { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false };
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5-3-flash-low",
          input: "Find the hostname.",
          tools: [{ type: "function", name: "exec_command", description: "Codex command policy text", parameters: schema, strict: true }],
          parallel_tool_calls: true,
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output).toHaveLength(1);
      expect(body.output[0]).toMatchObject({
        type: "function_call",
        call_id: "devin-call-001",
        name: "exec_command",
        arguments: '{"cmd":"hostname"}',
      });
      expect(captured).toBeDefined();
      const request = decodeChatRequest(captured!);
      expect(request.modelUid).toBe("glm-5-3-flash-low");
      expect(request.tools).toEqual([{
        name: "exec_command",
        description: "Run a local command.",
        schema: JSON.stringify(schema),
        strict: true,
      }]);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("continues function_call history with the same ID and local result", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({ captureChatRequest: (body) => { captured = body; } });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "swe-2-medium",
          input: [
            { type: "function_call", id: "fc-item-1", call_id: "devin-call-002", name: "exec_command", arguments: '{"cmd":"hostname"}' },
            { type: "function_call_output", call_id: "devin-call-002", output: "test-host" },
            { role: "user", content: "Report the result." },
          ],
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        }),
      });
      expect(res.status).toBe(200);
      expect(captured).toBeDefined();
      const request = decodeChatRequest(captured!);
      expect(request.modelUid).toBe("swe-2-medium");
      expect(request.prompts).toEqual([
        {
          source: 2,
          toolCalls: [{ id: "devin-call-002", name: "exec_command", argumentsJson: '{"cmd":"hostname"}' }],
        },
        { source: 4, prompt: "test-host", toolCallId: "devin-call-002", toolCalls: [] },
        { source: 1, prompt: "Report the result.", toolCalls: [] },
      ]);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("restores namespace for each of the five native multi_agent_v1 functions", async () => {
    const names = ["spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent"];
    let nextCall = 0;
    const upstream = startUpstream({
      chatBody: () => framesBody([dataFrame({
        toolCalls: [{ id: `agent-call-${nextCall}`, name: `multi_agent_v1__${names[nextCall++]}`, argumentsJson: "{}" }],
        stopReason: 10,
      })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      for (const name of names) {
        const res = await fetch(`${url}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "glm-5-3-flash-low",
            input: "Run one operation.",
            tools: [{
              type: "namespace", name: "multi_agent_v1",
              tools: names.map((toolName) => ({ type: "function", name: toolName, parameters: { type: "object" } })),
            }],
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.output[0]).toMatchObject({
          type: "function_call",
          namespace: "multi_agent_v1",
          name,
          arguments: "{}",
        });
      }
      expect(nextCall).toBe(5);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("returns an explicit error instead of accepting multiple Devin tool calls", async () => {
    const upstream = startUpstream({
      chatBody: () => framesBody([dataFrame({
        toolCalls: [
          { id: "call-a", name: "exec_command", argumentsJson: "{}" },
          { id: "call-b", name: "exec_command", argumentsJson: "{}" },
        ],
        stopReason: 10,
      })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5-3-flash-low", input: "Do one thing.",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        }),
      });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        error: { message: "Devin returned multiple function calls; this gateway supports one call per model response.", type: "api_error" },
      });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("reconstructs cumulative argument snapshots and later fragments across Devin frames", async () => {
    const upstream = startUpstream({
      chatBody: () => framesBody([
        dataFrame({ toolCalls: [{ id: "snapshot-call", name: "exec_command", argumentsJson: '{"cmd":' }] }),
        dataFrame({ toolCalls: [{ id: "snapshot-call", name: "exec_command", argumentsJson: '{"cmd":"hostname"' }] }),
        dataFrame({ toolCalls: [{ id: "", name: "", argumentsJson: "}" }], stopReason: 10 }),
      ]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "glm-5-3-flash-low", input: "Run hostname.",
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output).toHaveLength(1);
      expect(body.output[0].call_id).toBe("snapshot-call");
      expect(body.output[0].arguments).toBe('{"cmd":"hostname"}');
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("system collapse is opt-in and applies provider-wide in the Responses endpoint", async () => {
    const originalFlag = process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM;
    process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM = "1";
    const captured: Uint8Array[] = [];
    const upstream = startUpstream({ captureChatRequest: (body) => captured.push(body) });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      for (const model of ["glm-5-3-flash-low", "swe-2-medium", "unrelated-model"]) {
        const res = await fetch(`${url}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            instructions: "Top-level Codex catalog",
            input: [
              { role: "developer", content: "Desktop developer block" },
              { role: "user", content: "User task" },
            ],
          }),
        });
        expect(res.status).toBe(200);
      }
      expect(captured).toHaveLength(3);
      const [glm, swe, unrelated] = captured.map(decodeChatRequest);
      const exactSystem = "Top-level Codex catalog\n\nDesktop developer block";
      expect(glm.prompt).toBe("");
      expect(glm.prompts).toEqual([{ source: 1, prompt: `<system>\n${exactSystem}\n</system>\n\nUser task`, toolCalls: [] }]);
      expect(swe.prompt).toBe("");
      expect(swe.prompts[0].prompt).toBe(`<system>\n${exactSystem}\n</system>\n\nUser task`);
      expect(unrelated.prompt).toBe("");
      expect(unrelated.prompts[0].prompt).toBe(`<system>\n${exactSystem}\n</system>\n\nUser task`);
    } finally {
      await cleanup();
      await upstream.stop();
      if (originalFlag === undefined) delete process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM;
      else process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM = originalFlag;
    }
  });

});

test("Desktop logical High A/B flow retains opaque bridge IDs and promotes only after normalized continuation", async () => {
  for (const stream of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "synthetic-desktop-status-"));
    const path = join(directory, "safe.jsonl");
    const oldFlag = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS;
    const oldPath = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH;
    const oldCollapse = process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM;
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1";
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = path;
    process.env.DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM = "1";
    const id = "synthetic-provider[call]=+" + "x".repeat(160);
    const privatePrompt = `Synthetic Desktop history references swe-2 swe-2-max ${id}; do not persist this text`;
    let calls = 0;
    const upstream = startUpstream({ modelsBody: familyPayload([familyFixture("swe-2-high", "SWE-2", "high")]), chatBody: () => framesBody([
      dataFrame({ usage: { inputTokens: 10, outputTokens: 5 } }),
      dataFrame({ thinking: "Synthetic private thinking" }),
      ++calls === 1 ? dataFrame({ toolCalls: [{ id, name: "exec_command", argumentsJson: '{"cmd":"synthetic-private-command"}' }] }) : dataFrame({ text: "Synthetic private result" }),
      dataFrame({ stopReason: 10 }),
    ]) });
    const gateway = await startGateway(upstream.url.origin, "synthetic-private-key", { directory });
    try {
      const send = async (items: unknown[]) => {
        const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: "swe-2", reasoning: { effort: "high" }, stream, instructions: privatePrompt,
          input: [{ role: "developer", content: privatePrompt }, { role: "user", content: privatePrompt }, ...items],
          tools: [{ type: "function", name: "exec_command", description: privatePrompt, parameters: { type: "object", description: privatePrompt } }],
        }) }); expect(response.status).toBe(200); return response.text();
      };
      const emitted = await send([]); expect(emitted).toContain(id);
      expect(JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8")).variants).toEqual({});
      await send([{ type: "function_call", call_id: id, name: "exec_command", arguments: '{"cmd":"synthetic-private-command"}' },
        { type: "function_call_output", call_id: id, output: "Process exited with code 0\nFinal output:\nSynthetic private hostname" }]);
      await gateway.cleanup();
      const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(records).toHaveLength(2);
      for (const r of records) expect(r).toMatchObject({ logical_model: "swe-2", requested_effort: "high", resolved_model_id: "swe-2-high", upstream_terminal_status: "completed", response_failed_source: "none" });
      expect(records[0]).toMatchObject({ had_tool_call: true, had_function_call_output: false, upstream_event_types: ["usage", "thinking", "toolcall", "done"] });
      expect(records[1]).toMatchObject({ had_tool_call: false, had_function_call_output: true, upstream_event_types: ["usage", "thinking", "text", "done"] });
      expect(records[0]).toMatchObject({ upstream_toolcall_event_count: 1, normalized_tool_call_object_count: 1, bridge_completed_tool_call_count: 1, responses_tool_call_emitted_count: 1, tool_evidence_emitted_count: 1, correlation_results: { issued_call_recorded: 1 } });
      expect(records[1]).toMatchObject({ function_call_output_input_count: 1, tool_evidence_returned_count: 1, normalized_input_type_counts: { function_call_output: 1, assistant_function_call: 1 }, correlation_results: { matched_success: 1 } });
      expect(JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8")).variants["swe-2-high"].automatic).toMatchObject({ logicalModel: "swe-2", effort: "high" });
      const jsonl = readFileSync(path, "utf8");
      for (const raw of [id, privatePrompt, "synthetic-private-key", "synthetic-private-command", "Synthetic private hostname", "Synthetic private thinking"]) expect(jsonl).not.toContain(raw);
    } finally {
      await gateway.cleanup(); await upstream.stop(); rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of [["DEVIN_RESPONSES_SAFE_DIAGNOSTICS", oldFlag], ["DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH", oldPath], ["DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM", oldCollapse]]) {
        if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
      }
    }
  }
});

test("logical GLM Low and SWE High retain equivalent auto/required/specific Responses tool-choice contracts", async () => {
  const models = familyPayload([familyFixture("glm-5-3-flash-low", "GLM-5.3 Flash", "low", { context1m: true }), familyFixture("swe-2-high", "SWE-2", "high")]);
  const captured: Uint8Array[] = [];
  const upstream = startUpstream({ modelsBody: models, captureChatRequest: body => captured.push(body) });
  const gateway = await startGateway(upstream.url.origin, "synthetic-choice-key");
  try {
    for (const stream of [false, true]) for (const choice of ["auto", "required", { type: "function", name: "exec_command" }]) {
      captured.length = 0;
      for (const [model, effort] of [["glm-5-3-flash-1m", "low"], ["swe-2", "high"]]) {
        const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model, reasoning: { effort }, stream, tool_choice: choice, parallel_tool_calls: true, input: "Synthetic identical acceptance instruction",
          tools: [{ type: "function", name: "exec_command", description: "Synthetic command tool", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
        }) }); expect(response.status).toBe(200); await response.text();
      }
      expect(captured).toHaveLength(2);
      const decoded = captured.map(decodeChatRequest);
      expect(decoded.map(r => r.modelUid)).toEqual(["glm-5-3-flash-low", "swe-2-high"]);
      expect(decoded[0].tools).toEqual(decoded[1].tools);
      expect(decoded.map(r => r.disableParallelToolCalls)).toEqual([true, true]);
      const expected = choice === "auto" ? { optionName: "auto" } : choice === "required" ? { optionName: "any" } : { toolName: "exec_command" };
      for (const body of captured) expect(decodeChatRequestToolChoice(body)).toEqual(expected);
    }
  } finally { await gateway.cleanup(); await upstream.stop(); }
});

test("long bridge-emitted call retains evidence without altering Responses identity or exposing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-id-boundary-"));
  const path = join(directory, "safe.jsonl"); const oldFlag = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS; const oldPath = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH;
  process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1"; process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = path;
  // Existing protobuf call shape, with a nonempty ID beyond the diagnostic limit.
  // This characterizes a real validation boundary, not a claim about live SWE IDs.
  const id = "synthetic-long-call-" + "x".repeat(140);
  const upstream = startUpstream({ chatBody: () => framesBody([dataFrame({ usage: { inputTokens: 1, outputTokens: 1 } }), dataFrame({ thinking: "Synthetic private thinking" }), dataFrame({ toolCalls: [{ id, name: "exec_command", argumentsJson: "{}" }] })]) });
  const gateway = await startGateway(upstream.url.origin, "synthetic-boundary-key");
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-high", reasoning: { effort: "high" }, input: "Synthetic private prompt", tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }] }) });
    expect(response.status).toBe(200); expect((await response.json()).output[0].call_id).toBe(id);
    const r = JSON.parse(readFileSync(path, "utf8"));
    expect(r).toMatchObject({ upstream_toolcall_event_count: 1, normalized_tool_call_object_count: 1, bridge_completed_tool_call_count: 1, responses_tool_call_emitted_count: 1, tool_evidence_emitted_count: 1, had_tool_call: true });
    expect(r.identifier_checks).toContainEqual({ stage: "emitted_evidence", field: "call_id", state: "accepted", reason: "none", sensitive_text_overlap: false });
    expect(readFileSync(path, "utf8")).not.toContain(id);
  } finally { await gateway.cleanup(); await upstream.stop(); rmSync(directory, { recursive: true, force: true }); if (oldFlag === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = oldFlag; if (oldPath === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = oldPath; }
});

describe("large incoming Responses catalogs", () => {
  test("specific filtered tool and duplicate/invalid supported declarations fail before chat", async () => {
    let chatCount = 0;
    const upstream = startUpstream({ captureChatRequest: () => { chatCount++; } });
    const gateway = await startGateway(upstream.url.origin, "synthetic-key");
    try {
      const tools = incomingCatalog(128);
      for (const body of [
        { tools, tool_choice: { type: "function", namespace: "namespace_a", name: "search" } },
        { tools: [...tools, { type: "function", name: "exec_command", parameters: {} }] },
        { tools: [...tools, { type: "function", name: "exec_command", parameters: [] }] },
      ]) {
        const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-medium", input: "Synthetic", ...body }) });
        expect(response.status).toBe(400);
        expect((await response.json()).error.type).toBe("invalid_request_error");
      }
      expect(chatCount).toBe(0);
    } finally { await gateway.cleanup(); await upstream.stop(); }
  });
  for (const stream of [false, true]) for (const position of [0, 3, 5]) {
    test(`large catalog return/choice position ${position} and continuation (${stream ? "SSE" : "JSON"})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "synthetic-catalog-"));
      const oldFlag = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS;
      const oldPath = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH;
      const path = join(directory, "safe.jsonl");
      process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1";
      process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = path;
      const tools = incomingCatalog(128, 4096);
      const mapped = responsesToolsetToDevin(tools);
      const target = mapped.tools[position]; const identity = mapped.identities.get(target.name)!;
      const captured: ReturnType<typeof decodeChatRequest>[] = [];
      const choices: ReturnType<typeof decodeChatRequestToolChoice>[] = [];
      let count = 0;
      const upstream = startUpstream({
        captureChatRequest: bytes => { captured.push(decodeChatRequest(bytes)); choices.push(decodeChatRequestToolChoice(bytes)); },
        chatBody: () => ++count % 2 === 1
          ? framesBody([dataFrame({ toolCalls: [{ id: `synthetic-catalog-call-${position}`, name: target.name, argumentsJson: '{"marker":"synthetic"}' }], stopReason: 10 })])
          : framesBody([dataFrame({ text: "SYNTHETIC_CATALOG_FINAL" })]),
      });
      const gateway = await startGateway(upstream.url.origin, "synthetic-catalog-credential");
      try {
        for (const choice of ["auto", "required", { type: "function", ...identity }]) {
          const send = async (input: unknown, declarations: unknown) => {
            const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-medium", stream, input, tools: declarations, tool_choice: choice, parallel_tool_calls: true }) });
            expect(response.status).toBe(200); const wire = await response.text();
            const events = stream ? parseSse(wire).map(event => JSON.parse(event.data)) : [];
            expect(events.some(event => event.type === "response.failed")).toBe(false);
            return stream ? events.find(event => event.type === "response.completed").response : JSON.parse(wire);
          };
          const emitted = await send("Synthetic catalog request", tools);
          const call = emitted.output[0];
          expect(call).toMatchObject({ type: "function_call", call_id: `synthetic-catalog-call-${position}`, ...identity });
          const completed = await send([
            { role: "user", content: "Synthetic catalog request" }, call,
            { type: "function_call_output", call_id: call.call_id, output: "Exit code: 0\nOutput:\nSynthetic catalog result" },
          ], [...tools].reverse());
          expect(completed.output[0].content[0].text).toBe("SYNTHETIC_CATALOG_FINAL");
          for (const request of captured.slice(-2)) {
            expect(new Map(request.tools.map(t => [t.name, t]))).toEqual(new Map(mapped.tools.map(t => [t.name, { name: t.name, description: t.description, schema: t.jsonSchemaString, strict: t.strict }])));
            expect(request.disableParallelToolCalls).toBe(true);
          }
          expect(captured.at(-1)!.prompts).toEqual([
            { source: 1, prompt: "Synthetic catalog request", toolCalls: [] },
            { source: 2, toolCalls: [{ id: call.call_id, name: target.name, argumentsJson: call.arguments }] },
            { source: 4, prompt: "Exit code: 0\nOutput:\nSynthetic catalog result", toolCallId: call.call_id, toolCalls: [] },
          ]);
          const expectedChoice = choice === "auto" ? { optionName: "auto" } : choice === "required" ? { optionName: "any" } : { toolName: target.name };
          expect(choices.slice(-2)).toEqual([expectedChoice, expectedChoice]);
        }
        const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(records).toHaveLength(6);
        for (let index = 0; index < records.length; index++) {
          expect(records[index].tool_count).toBe(6);
          expect(records[index].forwarded_tool_fingerprints).toHaveLength(6);
          expect(records[index].had_tool_call).toBe(index % 2 === 0);
          expect(records[index].had_function_call_output).toBe(index % 2 === 1);
        }
        const safe = JSON.stringify(records);
        for (const privateValue of ["Synthetic private", "synthetic-schema-", "synthetic-catalog-call-", "synthetic-catalog-credential", "Synthetic catalog result", "Synthetic catalog request"]) expect(safe).not.toContain(privateValue);
      } finally {
        await gateway.cleanup(); await upstream.stop(); rmSync(directory, { recursive: true, force: true });
        if (oldFlag === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = oldFlag;
        if (oldPath === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = oldPath;
      }
    });
  }
});

// Synthetic full-history fixtures: no commands are executed by these tests.
describe("sequential Responses tool loops", () => {
  const tools = [{ type: "function", name: "exec_command", parameters: { type: "object" } }];
  test("downstream HTTP abort propagates to the active upstream request", async () => {
    let aborted = false;
    const upstream = Bun.serve({ hostname: HOST, port: 0, fetch(req) {
      if (new URL(req.url).pathname === DEVIN_AUTH_PATH) return new Response(Uint8Array.from(encodeString(1, "synthetic-jwt")));
      req.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(dataFrame({ text: "Synthetic first delta" })); } }));
    } });
    const gateway = await startGateway(upstream.url.origin, "synthetic-key");
    const client = new AbortController();
    try {
      const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", signal: client.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-medium", input: "Synthetic", stream: true }) });
      const reader = response.body!.getReader();
      let received = "";
      const deadline = Date.now() + 2000;
      while (!received.includes("response.output_text.delta") && Date.now() < deadline) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Synthetic first delta deadline")), Math.max(1, deadline - Date.now())); }),
        ]).finally(() => clearTimeout(timeout));
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toContain("response.output_text.delta");
      client.abort();
      await reader.cancel().catch(() => {}); reader.releaseLock();
      const abortDeadline = Date.now() + 2000;
      while (!aborted && Date.now() < abortDeadline) await Bun.sleep(5);
      expect(aborted).toBe(true);
    } finally { client.abort(); await upstream.stop(true); await gateway.cleanup(); }
  }, 6000);
  async function sequence(stream: boolean, cycles: number, failAt?: number) {
    const directory = mkdtempSync(join(tmpdir(), "synthetic-sequential-"));
    const oldFlag = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS;
    const oldPath = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH;
    const diagnosticPath = join(directory, "safe.jsonl");
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1";
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = diagnosticPath;
    const captured: ReturnType<typeof decodeChatRequest>[] = [];
    let request = 0;
    const upstream = startUpstream({
      captureChatRequest: bytes => captured.push(decodeChatRequest(bytes)),
      chatBody: () => {
        const index = request++;
        if (index === failAt) return framesBody([], { error: { code: "internal", message: "synthetic failure" } });
        return index < cycles
          ? framesBody([dataFrame({ toolCalls: [{ id: `synthetic-cycle-${index}`, name: "exec_command", argumentsJson: JSON.stringify({ cmd: `synthetic-step-${index}` }) }], stopReason: 10 })])
          : framesBody([dataFrame({ text: "SYNTHETIC_FINAL" })]);
      },
    });
    const gateway = await startGateway(upstream.url.origin, "synthetic-sequential-credential", { directory });
    const history: Record<string, unknown>[] = [{ role: "user", content: "Synthetic sequential task" }];
    const expected: ReturnType<typeof decodeChatRequest>["prompts"] = [{ source: 1, prompt: "Synthetic sequential task", toolCalls: [] }];
    let previousRevision = 1;
    try {
      for (let index = 0; index <= cycles; index++) {
        const response = await fetch(`${gateway.url}/v1/responses`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "swe-2-high", reasoning: { effort: "high" }, stream, input: history, tools, parallel_tool_calls: true }),
        });
        const wire = await response.text();
        const events = stream ? parseSse(wire).map(event => JSON.parse(event.data)) : [];
        expect(captured[index].prompts).toEqual(expected);
        expect(captured[index].disableParallelToolCalls).toBe(true);
        const records = readFileSync(diagnosticPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
        const diagnostic = records.at(-1);
        if (index === failAt) {
          if (stream) {
            expect(events.filter(event => event.type === "response.failed")).toHaveLength(1);
            expect(events.some(event => event.type === "response.completed")).toBe(false);
          } else {
            expect(response.status).toBe(502);
            expect(JSON.parse(wire).error).toBeDefined();
          }
          expect(diagnostic.correlation_results).toEqual({ request_ineligible: 1 });
          const saved = JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8"));
          expect(saved.revision).toBe(previousRevision);
          if (index > 1) expect(saved.variants["swe-2-high"].automatic.effort).toBe("high");
          break;
        }
        expect(response.status).toBe(200);
        expect(events.some(event => event.type === "response.failed")).toBe(false);
        const completed = stream ? events.find(event => event.type === "response.completed").response : JSON.parse(wire);
        expect(completed.status).toBe("completed");
        if (index < cycles) {
          expect(completed.output).toHaveLength(1);
          const call = completed.output[0];
          expect(call).toMatchObject({ type: "function_call", call_id: `synthetic-cycle-${index}`, name: "exec_command" });
          expect(JSON.parse(call.arguments)).toEqual({ cmd: `synthetic-step-${index}` });
          history.push(call, { type: "function_call_output", call_id: call.call_id, output: `Exit code: 0\nOutput:\nSynthetic result ${index}` });
          expected.push(
            { source: 2, toolCalls: [{ id: call.call_id, name: call.name, argumentsJson: JSON.stringify(JSON.parse(call.arguments)) }] },
            { source: 4, prompt: `Exit code: 0\nOutput:\nSynthetic result ${index}`, toolCallId: call.call_id, toolCalls: [] },
          );
          expect(diagnostic.correlation_results.issued_call_recorded).toBe(1);
        } else {
          expect(completed.output).toHaveLength(1);
          expect(completed.output[0].content[0].text).toBe("SYNTHETIC_FINAL");
        }
        if (index > 0) {
          expect(diagnostic.correlation_results.matched_success).toBe(1);
          if (index > 1) expect(diagnostic.correlation_results.no_issued_call).toBe(index - 1);
        }
        // Wait for the scheduled private status write, not an arbitrary sleep.
        const expectedRevision = index + 1;
        const deadline = Date.now() + 2000;
        while (JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8")).revision !== expectedRevision && Date.now() < deadline) {
          await Bun.sleep(5);
        }
        const saved = JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8"));
        expect(saved.revision).toBe(expectedRevision);
        previousRevision = expectedRevision;
      }
      const safe = readFileSync(diagnosticPath, "utf8");
      for (const secret of ["synthetic-cycle-", "synthetic-step-", "Synthetic result", "synthetic-sequential-credential", "Synthetic sequential task"]) expect(safe).not.toContain(secret);
      expect(captured.length).toBe((failAt ?? cycles) + 1);
    } finally {
      await gateway.cleanup(); await upstream.stop();
      rmSync(directory, { recursive: true, force: true });
      if (oldFlag === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = oldFlag;
      if (oldPath === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = oldPath;
    }
  }
  for (const stream of [false, true]) {
    for (const cycles of [2, 3]) test(`${cycles} sequential cycles preserve complete history, distinct identities and final completion (${stream ? "SSE" : "JSON"})`, () => sequence(stream, cycles));
    for (const failAt of [1, 2]) test(`continuation ${failAt} failure never fabricates success or clears prior Tested (${stream ? "SSE" : "JSON"})`, () => sequence(stream, 2, failAt));
  }

  test("text around a tool frame is combined before the completed function call", async () => {
    const upstream = startUpstream({ chatBody: () => framesBody([
      dataFrame({ text: "Synthetic before." }),
      dataFrame({ toolCalls: [{ id: "synthetic-mixed", name: "exec_command", argumentsJson: "{}" }] }),
      dataFrame({ text: "Synthetic after." }),
    ]) });
    const gateway = await startGateway(upstream.url.origin, "synthetic-key");
    try {
      for (const stream of [false, true]) {
        const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-medium", input: "Synthetic", tools, stream }) });
        const wire = await response.text();
        const output = stream ? parseSse(wire).map(e => JSON.parse(e.data)).find(e => e.type === "response.completed").response.output : JSON.parse(wire).output;
        expect(output.map((item: { type: string }) => item.type)).toEqual(["message", "function_call"]);
        expect(output[0].content[0].text).toBe("Synthetic before.Synthetic after.");
        expect(output[1].call_id).toBe("synthetic-mixed");
      }
    } finally { await gateway.cleanup(); await upstream.stop(); }
  });
});

describe("offline multi-agent lifecycle transport", () => {
  for (const childCount of [1, 2]) test(`disconnect with ${childCount} synthetic active children aborts upstream without inventing child cleanup`, async () => {
    let aborted = false;
    let requests = 0;
    const upstream = Bun.serve({ hostname: HOST, port: 0, fetch(req) {
      if (new URL(req.url).pathname === DEVIN_AUTH_PATH) return new Response(Uint8Array.from(encodeString(1, "synthetic-jwt")));
      requests++;
      req.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(dataFrame({ text: "Synthetic waiting delta" })); } }));
    } });
    const gateway = await startGateway(upstream.url.origin, "synthetic-key");
    const client = new AbortController();
    try {
      const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", signal: client.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-medium", stream: true, input: [
        { role: "user", content: "Synthetic parent" },
        ...Array.from({ length: childCount }, (_, index) => [
          { type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", call_id: `synthetic-spawn-${index}`, arguments: "{}" },
          { type: "function_call_output", call_id: `synthetic-spawn-${index}`, output: JSON.stringify({ agent_id: `00000000-0000-4000-8000-00000000000${index + 1}` }) },
        ]).flat(),
      ] }) });
      const reader = response.body!.getReader();
      let text = "";
      try {
        const deadline = Date.now() + 2000;
        while (!text.includes("response.output_text.delta")) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Synthetic agent delta deadline")), Math.max(1, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
          if (part.done) break;
          text += new TextDecoder().decode(part.value);
        }
        expect(text).toContain("response.output_text.delta");
        client.abort(); await reader.cancel().catch(() => {});
      } finally { reader.releaseLock(); }
      const deadline = Date.now() + 2000;
      while (!aborted && Date.now() < deadline) await Bun.sleep(5);
      expect(aborted).toBe(true);
      expect(requests).toBe(1);
    } finally { client.abort(); await gateway.cleanup(); await upstream.stop(true); }
  }, 6000);
  // Synthetic results characterize transport, not execution of a Codex runtime.
  const agentA = "00000000-0000-4000-8000-000000000001";
  const agentB = "00000000-0000-4000-8000-000000000002";
  const names = ["spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent"];
  const tools = [
    { type: "namespace", name: "multi_agent_v1", tools: names.map(name => ({ type: "function", name, parameters: { type: "object" } })) },
    { type: "function", name: "exec_command", parameters: { type: "object" } },
  ];
  type Step = { name: string; args: Record<string, unknown>; output: string };
  const spawn: Step = { name: "spawn_agent", args: { agent_type: "swe_worker", message: "Synthetic child task" }, output: JSON.stringify({ agent_id: agentA, nickname: "Synthetic worker" }) };
  const wait: Step = { name: "wait_agent", args: { targets: [agentA], timeout_ms: 30000 }, output: JSON.stringify({ status: { [agentA]: { completed: "Synthetic child result" } }, timed_out: false }) };
  const pending: Step = { ...wait, output: JSON.stringify({ status: {}, timed_out: true }) };
  const send: Step = { name: "send_input", args: { target: agentA, message: "Synthetic follow-up", interrupt: false }, output: JSON.stringify({ submission_id: "synthetic-submission" }) };
  const close: Step = { name: "close_agent", args: { target: agentA }, output: JSON.stringify({ previous_status: "shutdown" }) };
  const resume: Step = { name: "resume_agent", args: { id: agentA }, output: JSON.stringify({ status: "running" }) };
  const spawnB: Step = { ...spawn, args: { agent_type: "swe_worker", message: "Synthetic child B task" }, output: JSON.stringify({ agent_id: agentB, nickname: "Synthetic worker B" }) };
  const waitB: Step = { ...wait, args: { targets: [agentB], timeout_ms: 30000 }, output: JSON.stringify({ status: { [agentB]: { completed: "Synthetic child B result" } }, timed_out: false }) };
  const closeB: Step = { ...close, args: { target: agentB } };
  const failedA: Step = { ...wait, output: JSON.stringify({ status: { [agentA]: { errored: "Synthetic child A failure" } }, timed_out: false }) };
  const failedB: Step = { ...waitB, output: JSON.stringify({ status: { [agentB]: { errored: "Synthetic child B failure" } }, timed_out: false }) };
  const postSend: Step = { ...wait, output: JSON.stringify({ status: { [agentA]: { completed: "Synthetic post-send child A result" } }, timed_out: false }) };
  const sendB: Step = { ...send, args: { target: agentB, message: "Synthetic child B follow-up", interrupt: false }, output: JSON.stringify({ submission_id: "synthetic-submission-B" }) };
  const postSendB: Step = { ...waitB, output: JSON.stringify({ status: { [agentB]: { completed: "Synthetic post-send child B result" } }, timed_out: false }) };
  const scenarios: Array<{ name: string; steps: Step[]; failAt?: number }> = [
    { name: "completed open child receives send_input before post-send wait and close", steps: [spawn, wait, send, postSend, close] },
    { name: "send to A does not retarget B or replace B wait result", steps: [spawn, spawnB, wait, send, postSend, waitB, close, closeB] },
    { name: "distinct sends to A and B preserve target, submission and post-send result order", steps: [spawn, spawnB, wait, waitB, send, sendB, postSendB, postSend, closeB, close] },
    { name: "failed send leaves same child available for explicit close", steps: [spawn, wait, { ...send, output: JSON.stringify({ error: "Synthetic input submission failure" }) }, close] },
    { name: "upstream failure after send acknowledgement does not invent a child result", steps: [spawn, wait, send, close], failAt: 3 },
    { name: "close then resume same identity without submitting new child work", steps: [spawn, wait, close, { ...resume, output: JSON.stringify({ status: "pending_init" }) }, close] },
    { name: "resume already loaded completed child returns status without a new spawn", steps: [spawn, wait, { ...resume, output: JSON.stringify({ status: { completed: "Synthetic child result" } }) }, close] },
    { name: "resume error leaves explicit close history unchanged", steps: [spawn, wait, close, { ...resume, output: JSON.stringify({ error: "Synthetic resume failure" }) }, close] },
    { name: "two active siblings, isolated A/B spawn and wait results, close both", steps: [spawn, spawnB, wait, waitB, close, closeB] },
    { name: "two siblings with reversed wait order", steps: [spawn, spawnB, waitB, wait, close, closeB] },
    { name: "two siblings with reversed close order", steps: [spawn, spawnB, wait, waitB, closeB, close] },
    { name: "two siblings with reversed wait and close order", steps: [spawn, spawnB, waitB, wait, closeB, close] },
    { name: "close A leaves B target and result intact", steps: [spawn, spawnB, wait, close, waitB, closeB] },
    { name: "close B leaves A target and result intact", steps: [spawn, spawnB, waitB, closeB, wait, close] },
    { name: "A fails while B succeeds, explicit cleanup of both", steps: [spawn, spawnB, failedA, waitB, close, closeB] },
    { name: "B fails while A succeeds, explicit cleanup of both", steps: [spawn, spawnB, failedB, wait, closeB, close] },
    { name: "continuation fails with two active siblings, explicit cleanup of both", steps: [spawn, spawnB, close, closeB], failAt: 2 },
    { name: "spawn result, wait result, final", steps: [spawn, wait] },
    { name: "spawn, multiple sends, wait, final", steps: [spawn, send, send, wait] },
    { name: "spawn, pending wait, completed wait", steps: [spawn, pending, wait] },
    { name: "spawn, close, resume, wait, close again", steps: [spawn, close, resume, wait, close] },
    { name: "already closed and unknown resume results remain opaque", steps: [spawn, close, close, { ...resume, args: { id: agentB }, output: "agent with synthetic id not found" }] },
    { name: "invalid child target error remains an ordinary output", steps: [spawn, { ...send, args: { target: "synthetic-invalid-id", message: "Synthetic" }, output: "invalid agent id synthetic-invalid-id" }, close] },
    { name: "two different agent targets remain distinct in ordered history", steps: [spawn, { ...wait, args: { targets: [agentB] }, output: JSON.stringify({ status: { [agentB]: "not_found" }, timed_out: false }) }, wait] },
    { name: "agent history mixes with exec history and replay", steps: [spawn, { name: "exec_command", args: { cmd: "synthetic-command" }, output: "Exit code: 0\nOutput:\nSynthetic command result" }, wait] },
    { name: "continuation failure after spawn, followed by explicit close", steps: [spawn, close], failAt: 1 },
    { name: "upstream failure during wait continuation, followed by explicit close", steps: [spawn, wait, close], failAt: 2 },
    { name: "child errored during wait, followed by close", steps: [spawn, { ...wait, output: JSON.stringify({ status: { [agentA]: { errored: "Synthetic child failure" } }, timed_out: false }) }, close] },
  ];
  for (const stream of [false, true]) for (const scenario of scenarios) {
    test(`${scenario.name} (${stream ? "SSE" : "JSON"})`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "synthetic-agent-transport-"));
      const oldFlag = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS;
      const oldPath = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH;
      const diagnosticPath = join(directory, "safe.jsonl");
      process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1";
      process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = diagnosticPath;
      const captured: ReturnType<typeof decodeChatRequest>[] = [];
      let emitted = 0;
      let failed = false;
      const upstream = startUpstream({
        captureChatRequest: bytes => captured.push(decodeChatRequest(bytes)),
        chatBody: () => {
          if (emitted === scenario.failAt && !failed) {
            failed = true;
            return framesBody([], { error: { code: "internal", message: "Synthetic continuation failure" } });
          }
          const step = scenario.steps[emitted];
          if (!step) return framesBody([dataFrame({ text: "SYNTHETIC_AGENT_FINAL" })]);
          const id = `synthetic-agent-call-${emitted++}`;
          const name = step.name === "exec_command" ? step.name : `multi_agent_v1__${step.name}`;
          // Two cumulative deltas must produce one restored call, not two spawns.
          const args = JSON.stringify(step.args);
          return framesBody([
            dataFrame({ toolCalls: [{ id, name, argumentsJson: args.slice(0, 8) }] }),
            dataFrame({ toolCalls: [{ id, name, argumentsJson: args }], stopReason: 10 }),
          ]);
        },
      });
      const gateway = await startGateway(upstream.url.origin, "synthetic-agent-credential", { directory });
      const history: Record<string, unknown>[] = [{ role: "user", content: "Synthetic parent task" }];
      const expected: ReturnType<typeof decodeChatRequest>["prompts"] = [{ source: 1, prompt: "Synthetic parent task", toolCalls: [] }];
      try {
        const count = scenario.steps.length + 1 + (scenario.failAt === undefined ? 0 : 1);
        for (let request = 0; request < count; request++) {
          const before = emitted;
          const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "swe-2-high", reasoning: { effort: "high" }, stream, input: history, tools }) });
          const wire = await response.text();
          const events = stream ? parseSse(wire).map(e => JSON.parse(e.data)) : [];
          expect(captured[request].prompts).toEqual(expected);
          expect(captured[request].disableParallelToolCalls).toBe(true);
          expect(captured[request].tools.map(t => t.name)).toEqual([...names.map(n => `multi_agent_v1__${n}`), "exec_command"]);
          if (before === scenario.failAt && emitted === before) {
            if (stream) {
              expect(events.filter(e => e.type === "response.failed")).toHaveLength(1);
              expect(events.some(e => e.type === "response.completed")).toBe(false);
            } else expect(response.status).toBe(502);
            // No fabricated output is appended; next request explicitly asks for cleanup.
            history.push({ role: "user", content: "Synthetic explicit cleanup" });
            expected.push({ source: 1, prompt: "Synthetic explicit cleanup", toolCalls: [] });
            continue;
          }
          expect(response.status).toBe(200);
          const completed = stream ? events.find(e => e.type === "response.completed").response : JSON.parse(wire);
          expect(completed.status).toBe("completed");
          expect(completed.output).toHaveLength(1);
          if (before === scenario.steps.length) {
            expect(completed.output[0].content[0].text).toBe("SYNTHETIC_AGENT_FINAL");
            continue;
          }
          const step = scenario.steps[before];
          const call = completed.output[0];
          const namespace = step.name === "exec_command" ? undefined : "multi_agent_v1";
          expect(call).toMatchObject({ type: "function_call", call_id: `synthetic-agent-call-${before}`, name: step.name });
          expect(call.namespace).toBe(namespace);
          expect(JSON.parse(call.arguments)).toEqual(step.args);
          expect(call.call_id).not.toBe(agentA);
          expect(call.call_id).not.toBe(agentB);
          history.push(call, { type: "function_call_output", call_id: call.call_id, output: step.output });
          expected.push(
            { source: 2, toolCalls: [{ id: call.call_id, name: namespace ? `${namespace}__${step.name}` : step.name, argumentsJson: JSON.stringify(step.args) }] },
            { source: 4, prompt: step.output, toolCallId: call.call_id, toolCalls: [] },
          );
        }
        const safe = readFileSync(diagnosticPath, "utf8");
        for (const privateValue of [agentA, agentB, "synthetic-agent-call-", "Synthetic child", "synthetic-submission", "synthetic-agent-credential", "synthetic-command"]) expect(safe).not.toContain(privateValue);
        const records = safe.trim().split("\n").map(line => JSON.parse(line));
        // Native agent payloads are transported but not reclassified as terminal exec success.
        if (!scenario.steps.some(s => s.name === "exec_command")) {
          expect(records.some(r => r.correlation_results?.matched_success)).toBe(false);
          expect(JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8")).revision).toBe(1);
        }
        expect(records.some(r => r.correlation_results?.no_issued_call)).toBe(true);
      } finally {
        await gateway.cleanup(); await upstream.stop();
        rmSync(directory, { recursive: true, force: true });
        if (oldFlag === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = oldFlag;
        if (oldPath === undefined) delete process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH; else process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH = oldPath;
      }
    });
  }
});

// ─── POST /v1/messages (Anthropic, non-streaming) ────────────────────────────

test("runtime status persists only after an issued tool and its successful Responses continuation, streaming or JSON", async () => {
  for (const stream of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "synthetic-status-roundtrip-"));
    let calls = 0;
    const upstream = startUpstream({ chatBody: () => ++calls === 1
      ? framesBody([dataFrame({ toolCalls: [{ id: "synthetic-status-call", name: "exec_command", argumentsJson: '{"cmd":"synthetic"}' }], stopReason: 10 })])
      : defaultChatBody() });
    const { url, cleanup } = await startGateway(upstream.url.origin, "synthetic-key", { directory });
    try {
      const send = async (input: unknown) => {
        const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: "swe-2-medium", reasoning: { effort: "medium" }, stream, input,
          tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
        }) }); expect(response.status).toBe(200); await response.text();
      };
      await send("Synthetic private prompt");
      expect(JSON.parse(readFileSync(join(directory, "model-test-status.json"), "utf8")).variants).toEqual({});
      await send([{ type: "function_call", call_id: "synthetic-status-call", name: "exec_command", arguments: '{"cmd":"synthetic"}' },
        { type: "function_call_output", call_id: "synthetic-status-call", output: "Exit code: 0\nOutput:\nSynthetic private tool output" }]);
      await cleanup();
      const bytes = readFileSync(join(directory, "model-test-status.json"), "utf8");
      expect(JSON.parse(bytes).variants["swe-2-medium"].automatic).toMatchObject({ logicalModel: "swe-2-medium", effort: "medium" });
      expect(bytes).not.toContain("private"); expect(bytes).not.toContain("synthetic-key");
    } finally { await cleanup(); await upstream.stop(); rmSync(directory, { recursive: true, force: true }); }
  }
});

describe("POST /v1/messages (Anthropic, non-streaming)", () => {
  test("returns a message with text content, end_turn stop_reason, and usage", async () => {
    const upstream = startUpstream();
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.type).toBe("message");
      expect(body.content).toEqual([{ type: "text", text: "hi" }]);
      expect(body.stop_reason).toBe("end_turn");
      expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("emits a thinking content block before text", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([dataFrame({ thinking: "reasoning here", text: "answer" })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toEqual([
        { type: "thinking", thinking: "reasoning here" },
        { type: "text", text: "answer" },
      ]);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("maps tool calls to tool_use with parsed input and tool_use stop_reason", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([
          dataFrame({
            toolCalls: [
              { id: "toolu_1", name: "get_weather", argumentsJson: '{"city":"SF"}' },
            ],
          }),
        ]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          messages: [{ role: "user", content: "weather?" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toEqual([
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
      ]);
      expect(body.stop_reason).toBe("tool_use");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("defaults usage to zero tokens when the upstream sends none", async () => {
    const upstream = startUpstream({
      chatBody: () => framesBody([dataFrame({ text: "hi" })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("aggregates a string system prompt into the upstream systemPrompt", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => {
        captured = b;
      },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          system: "You are helpful.",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(decodeChatRequestPrompt(captured!)).toBe("You are helpful.");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("joins system block arrays into the upstream systemPrompt", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => {
        captured = b;
      },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          system: [
            { type: "text", text: "You are helpful." },
            { type: "text", text: "Be safe." },
          ],
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(decodeChatRequestPrompt(captured!)).toBe("You are helpful.\n\nBe safe.");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── POST /v1/messages (Anthropic, streaming) ────────────────────────────────

describe("POST /v1/messages stream=true", () => {
  test("emits the full Anthropic SSE event sequence for a text block", async () => {
    const upstream = startUpstream({
      chatBody: () => framesBody([dataFrame({ text: "hi" })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const events = parseSse(await res.text());
      const seq = events.map((e) => e.event);
      expect(seq).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);

      // content_block_start opens a text block
      const start = JSON.parse(events[1].data);
      expect(start.content_block.type).toBe("text");

      // content_block_delta is a text_delta carrying "hi"
      const delta = JSON.parse(events[2].data);
      expect(delta.delta.type).toBe("text_delta");
      expect(delta.delta.text).toBe("hi");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("switches content blocks from thinking to text", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([dataFrame({ thinking: "hmm" }), dataFrame({ text: "hi" })]),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);

      const events = parseSse(await res.text());
      const blockStarts = events
        .filter((e) => e.event === "content_block_start")
        .map((e) => JSON.parse(e.data).content_block.type);
      expect(blockStarts).toEqual(["thinking", "text"]);

      // thinking delta then text delta
      const deltas = events
        .filter((e) => e.event === "content_block_delta")
        .map((e) => JSON.parse(e.data).delta);
      expect(deltas[0]).toEqual({ type: "thinking_delta", thinking: "hmm" });
      expect(deltas[1]).toEqual({ type: "text_delta", text: "hi" });

      // two content_block_stop events (one per block)
      expect(events.filter((e) => e.event === "content_block_stop").length).toBe(2);
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── 502 error mapping across surfaces ───────────────────────────────────────

describe("502 error mapping", () => {
  test("responses surface maps a streamChat error to 502", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([dataFrame({ text: "hi" })], {
          error: { code: "internal", message: "fail" },
        }),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", input: "hi" }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain("redacted");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("anthropic messages surface maps a streamChat error to 502", async () => {
    const upstream = startUpstream({
      chatBody: () =>
        framesBody([dataFrame({ text: "hi" })], {
          error: { code: "internal", message: "fail" },
        }),
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "k");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "m",
          max_tokens: 100,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.message).toContain("redacted");
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});

// ─── tool_choice wiring ─────────────────────────────────────────────────────

describe("tool_choice wiring", () => {
  test("OpenAI 'auto' → Devin { optionName: 'auto' }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", messages: [{ role: "user", content: "hi" }],
          tool_choice: "auto",
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ optionName: "auto" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("OpenAI 'required' → Devin { optionName: 'any' }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", messages: [{ role: "user", content: "hi" }],
          tool_choice: "required",
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ optionName: "any" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("OpenAI { type: 'function', function: { name } } → Devin { toolName }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", messages: [{ role: "user", content: "hi" }],
          tool_choice: { type: "function", function: { name: "get_weather" } },
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ toolName: "get_weather" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("OpenAI 'none' → Devin { optionName: 'none' }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", messages: [{ role: "user", content: "hi" }],
          tool_choice: "none",
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ optionName: "none" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("OpenAI no tool_choice → default { optionName: 'auto' }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ optionName: "auto" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("Anthropic { type: 'any' } → Devin { optionName: 'any' }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
          tool_choice: { type: "any" },
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ optionName: "any" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("Anthropic { type: 'tool', name } → Devin { toolName }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
          tool_choice: { type: "tool", name: "search" },
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ toolName: "search" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });

  test("Anthropic no tool_choice → default { optionName: 'auto' }", async () => {
    let captured: Uint8Array | undefined;
    const upstream = startUpstream({
      captureChatRequest: (b) => { captured = b; },
    });
    const { url, cleanup } = await startGateway(upstream.url.origin, "tok");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok" },
        body: JSON.stringify({
          model: "m", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(decodeChatRequestToolChoice(captured!)).toEqual({ optionName: "auto" });
    } finally {
      await cleanup();
      await upstream.stop();
    }
  });
});
