import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { startServer } from "../src/server.ts";
import { ProtoEncoder, ProtoDecoder } from "../src/proto.ts";
import { familyFixture, familyPayload } from "./fixtures/model-families.ts";

test("Responses logical effort routes to exact wire UID; invalid efforts never generate chat", async () => {
  const models = [familyFixture("swe-2-medium", "SWE-2", "medium"), familyFixture("swe-2-high", "SWE-2", "high", {}, true), familyFixture("swe-2-max", "SWE-2", "max"),
    familyFixture("sol-wire-low", "GPT-6.1 Sol", "low"), familyFixture("sol-wire-medium", "GPT-6.1 Sol", "medium")];
  const calls: string[] = [];
  let discoveryAvailable = true;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith("GetCliModelConfigs")) return new Response(familyPayload(discoveryAvailable ? models : [models[0]]));
    if (path.endsWith("GetUserJwt")) { const e = new ProtoEncoder(); e.string(1, "synthetic-wire-jwt"); return new Response(e.finish()); }
    if (!path.endsWith("GetChatMessage")) return new Response(null, { status: 404 });
    const body = Buffer.from(await req.arrayBuffer());
    const d = new ProtoDecoder(body[0] === 1 ? gunzipSync(body.subarray(5)) : body.subarray(5));
    while (!d.done) { const { field, wire } = d.readTag(); if (field === 21 && wire === 2) calls.push(d.readString()); else d.skip(wire); }
    const e = new ProtoEncoder(); e.string(3, "SYNTHETIC_ROUTING_OK"); e.uint32(5, 1);
    const frame = (flag: number, data: Uint8Array) => { const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(data.length, 1); return Buffer.concat([header, data]); };
    return new Response(Buffer.concat([frame(0, e.finish()), frame(2, Buffer.from("{}"))]), { headers: { "content-type": "application/connect+proto" } });
  } });
  const signals = ["SIGINT", "SIGTERM"] as const;
  const before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port; await probe.stop();
  const gateway = await startServer({ host: "127.0.0.1", port, baseUrl: upstream.url.origin, token: "synthetic-wire-token" });
  try {
    const send = (model: string, effort?: string, stream = false) => fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, reasoning: effort ? { effort } : undefined, stream, input: "Synthetic offline routing fixture." }),
    });
    for (const effort of [undefined, "off", "low", "MAX"]) expect((await send("swe-2", effort)).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await send("swe-2", "medium")).status).toBe(200);
    const streaming = await send("swe-2", "high", true); expect(streaming.status).toBe(200); expect(await streaming.text()).toContain("response.completed");
    expect((await send("swe-2", "max")).status).toBe(200);
    expect((await send("swe-2-medium", "high")).status).toBe(200);
    expect((await send("gpt-6-1-sol")).status).toBe(400);
    expect((await send("gpt-6-1-sol", "medium")).status).toBe(200);
    expect(calls).toEqual(["swe-2-medium", "swe-2-high", "swe-2-max", "swe-2-medium", "sol-wire-medium"]);
    discoveryAvailable = false;
    expect((await send("gpt-6-1-sol", "medium")).status).toBe(400);
    expect(calls).toHaveLength(5);
    expect((await send("synthetic-legacy-concrete", "off")).status).toBe(200);
    expect(calls.at(-1)).toBe("synthetic-legacy-concrete");
  } finally {
    await gateway.stop(); await upstream.stop(true);
    for (const signal of signals) for (const listener of process.listeners(signal)) if (!before.get(signal)!.has(listener)) process.removeListener(signal, listener);
  }
});
