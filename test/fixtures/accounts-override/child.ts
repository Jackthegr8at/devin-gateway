// Child process for test/accounts-override.test.ts. Runs one gateway with a static key set in its environment and prints one JSON result line.
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const SESSION_PREFIX = "devin-session-token$";
const PERSONAL = "synthetic-override-personal-0401";
const TEAM = "synthetic-override-team-0402";
const STATIC = process.env.SYNTHETIC_STATIC_KEY ?? "";
const profiles = [{ id: "personal", name: "Personal" }, { id: "team", name: "Team" }];

const root = await mkdtemp(join(tmpdir(), "gateway-override-"));
const configDir = join(root, "auth");
const settingsDir = join(root, "settings");
process.env.DEVIN_GATEWAY_CONFIG_DIR = configDir;
process.env.DEVIN_GATEWAY_SETTINGS_DIR = settingsDir;
await mkdir(configDir, { recursive: true, mode: 0o700 });
await writeFile(join(configDir, "token"), `${PERSONAL}\n`, { mode: 0o600 });
await mkdir(join(configDir, "accounts", "team"), { recursive: true, mode: 0o700 });
await writeFile(join(configDir, "accounts", "team", "token"), `${TEAM}\n`, { mode: 0o600 });

const { ProtoDecoder, ProtoEncoder } = await import("../../../src/proto.ts");
const { initialModelSelection } = await import("../../../src/admin/model-selection.ts");
const { startServer } = await import("../../../src/server.ts");

function apiKeyOf(body: Uint8Array): string {
  const outer = new ProtoDecoder(body);
  while (outer.pos < body.length) {
    const { field, wire } = outer.readTag();
    if (field === 1 && wire === 2) {
      const meta = new ProtoDecoder(outer.readBytes());
      while (meta.pos < meta.bytes.length) {
        const tag = meta.readTag();
        if (tag.field === 3 && tag.wire === 2) return meta.readString();
        meta.skip(tag.wire);
      }
    } else outer.skip(wire);
  }
  return "";
}

const upstreamKeys: string[] = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === AUTH_PATH) {
    upstreamKeys.push(apiKeyOf(new Uint8Array(await req.arrayBuffer())));
    const e = new ProtoEncoder(); e.string(1, "synthetic-jwt"); return new Response(e.finish());
  }
  const encoder = new ProtoEncoder();
  for (const id of initialModelSelection().enabledModels) encoder.message(1, (model) => { model.string(1, id); model.string(22, id); model.bool(5, true); model.uint32(18, 262_000); });
  return new Response(encoder.finish());
} });
const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
const port = probe.port; await probe.stop();
const gateway = await startServer({ host: "127.0.0.1", port, baseUrl: upstream.url.origin, modelSelection: { directory: settingsDir, adminPort: 0 } });
const base = `http://127.0.0.1:${port}`;
const admin = `http://127.0.0.1:${gateway.adminPort}`;
const proxySecret = (await readFile(join(settingsDir, "admin-proxy-secret"), "utf8")).trim();

const result: Record<string, unknown> = {};
const view = await (await fetch(`${admin}/admin/api/accounts`)).json();
result.staticOverride = view.staticOverride;
result.leaksStaticInView = JSON.stringify(view).includes(STATIC);
const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag");
const refused = await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: { "content-type": "application/json", "x-devin-management": "1", "x-devin-admin-proxy": proxySecret, "if-match": etag ?? "" }, body: JSON.stringify({ activeProfileId: "team", profiles }) });
result.switchStatus = refused.status;
result.switchCode = (await refused.json() as { error?: { code?: string } }).error?.code;
result.activeAfterRefusal = (await (await fetch(`${admin}/admin/api/accounts`)).json()).activeProfileId;
await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
result.inferenceKey = upstreamKeys[0] ?? "";
result.inferenceUsesStatic = upstreamKeys[0] === `${SESSION_PREFIX}${STATIC}`;
upstreamKeys.length = 0;
await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-override-request-0404" }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
result.requestOverrideWins = upstreamKeys[0] === `${SESSION_PREFIX}synthetic-override-request-0404`;
const health = await (await fetch(`${base}/health`)).text();
result.healthFallback = health.includes('"fallback_token":"set"');
result.healthLeaksStatic = health.includes(STATIC);
console.log("RESULT " + JSON.stringify(result));
await gateway.stop();
upstream.stop(true);
await rm(root, { recursive: true, force: true });