import { expect, test, describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { startServer } from "../src/server.ts";
import { listModels } from "../src/models.ts";
import { ProtoDecoder } from "../src/proto.ts";

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
    if (field === 2 && wire === 2) result.prompt = d.readString();
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

async function startGateway(upstreamUrl: string, token?: string): Promise<Gateway> {
  const port = await reservePort();
  const before = new Map(SIGNALS.map((s) => [s, new Set(process.listeners(s))]));
  const handle = await startServer({
    host: HOST,
    port,
    token,
    baseUrl: upstreamUrl,
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

// ─── POST /v1/messages (Anthropic, non-streaming) ────────────────────────────

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
