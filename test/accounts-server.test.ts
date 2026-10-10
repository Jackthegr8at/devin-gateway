/**
 * Account profiles at the HTTP layer: credential precedence, switching,
 * admin authorization, and no credential leakage. Every token is synthetic
 * and no request reaches a real Devin endpoint. The fake upstream decodes the
 * GetUserJwt request, so each assertion checks which key Devin would receive.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "gateway-accounts-"));
const configDir = join(root, "auth");
const settingsDir = join(root, "settings");
process.env.DEVIN_GATEWAY_CONFIG_DIR = configDir;
process.env.DEVIN_GATEWAY_SETTINGS_DIR = settingsDir;
// The account suite runs with no static key. It is cleared in beforeAll, so another file loaded earlier cannot leak one in.

const { startServer } = await import("../src/server.ts");
const { ProtoEncoder, ProtoDecoder } = await import("../src/proto.ts");
const { initialModelSelection } = await import("../src/admin/model-selection.ts");

const AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const PERSONAL = "synthetic-personal-token-0001";
const TEAM = "synthetic-team-token-0002";
const REQUEST = "synthetic-request-token-0003";
const SESSION_PREFIX = "devin-session-token$";

/** API keys that reached the upstream auth exchange, in arrival order. */
const upstreamKeys: string[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let gateway: Awaited<ReturnType<typeof startServer>>;
let base = "";
let admin = "";

/** Decode the apiKey field (Metadata field 3 nested in field 1) of a GetUserJwt request. */
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

function modelPayload(): Uint8Array {
  const encoder = new ProtoEncoder();
  for (const id of initialModelSelection().enabledModels) encoder.message(1, (model) => {
    model.string(1, id); model.string(22, id); model.bool(5, true); model.uint32(18, 262_000);
    model.message(23, (info) => { info.uint32(13, 64_000); });
  });
  return encoder.finish();
}

function jwtPayload(): Uint8Array {
  const encoder = new ProtoEncoder();
  encoder.string(1, "synthetic-jwt");
  return encoder.finish();
}

beforeAll(async () => {
  delete process.env.DEVIN_API_KEY;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "token"), `${PERSONAL}\n`, { mode: 0o600 });
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (new URL(req.url).pathname === AUTH_PATH) {
      upstreamKeys.push(apiKeyOf(new Uint8Array(await req.arrayBuffer())));
      return new Response(jwtPayload());
    }
    if (new URL(req.url).pathname === "/exa.api_server_pb.ApiServerService/GetCliModelConfigs") {
      upstreamKeys.push(apiKeyOf(new Uint8Array(await req.arrayBuffer())));
    }
    return new Response(modelPayload());
  } });
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port; await probe.stop();
  gateway = await startServer({ host: "127.0.0.1", port, baseUrl: upstream.url.origin, modelSelection: { directory: settingsDir, adminPort: 0 } });
  base = `http://127.0.0.1:${port}`;
  proxySecretValue = (await readFile(join(settingsDir, "admin-proxy-secret"), "utf8")).trim();
  admin = `http://127.0.0.1:${gateway.adminPort}`;
});

afterAll(async () => {
  await gateway?.stop();
  upstream?.stop(true);
  await rm(root, { recursive: true, force: true });
});

// The proxy secret is read from the test settings directory, the same file Nginx mirrors. It is never printed.
let proxySecretValue = "";
const adminWrite = (etag: string, body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json", "x-devin-management": "1", "x-devin-admin-proxy": proxySecretValue, "if-match": etag },
  body: JSON.stringify(body),
});

const profiles = [{ id: "personal", name: "Personal" }, { id: "team", name: "Team" }];

describe("account profiles over HTTP", () => {
  test("GET reports both profiles, the active one, and no credential detail", async () => {
    const res = await fetch(`${admin}/admin/api/accounts`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PERSONAL);
    expect(text).not.toContain(TEAM);
    const body = JSON.parse(text);
    expect(body.activeProfileId).toBe("personal");
    expect(body.profiles).toEqual([
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "unconfigured" },
    ]);
    expect(res.headers.get("etag")).toBe(`"accounts-v1-${body.revision}"`);
  });

  test("admin writes are refused without the management header, JSON type, or If-Match", async () => {
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    const body = JSON.stringify({ activeProfileId: "personal", profiles });
    expect((await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: { "content-type": "application/json", "if-match": etag }, body })).status).toBe(403);
    expect((await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: { "x-devin-management": "1", "if-match": etag }, body })).status).toBe(415);
    expect((await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: { "content-type": "application/json", "x-devin-management": "1", "x-devin-admin-proxy": proxySecretValue }, body })).status).toBe(428);
  });

  test("browser cross-origin writes are refused by the management origin check", async () => {
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    const res = await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: { "content-type": "application/json", "x-devin-management": "1", "if-match": etag, origin: "https://example.com" }, body: JSON.stringify({ activeProfileId: "personal", profiles }) });
    expect(res.status).toBe(403);
  });

  test("admin model discovery uses the active account when no static key is set", async () => {
    upstreamKeys.length = 0;
    const res = await fetch(`${admin}/admin/api/models`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PERSONAL);
    expect(upstreamKeys).toContain(`${SESSION_PREFIX}${PERSONAL}`);
  });
  test("the inference listener never serves account administration", async () => {
    expect((await fetch(`${base}/admin/api/accounts`)).status).toBe(404);
  });

  test("switching to an unconfigured profile is refused and leaves the active profile unchanged", async () => {
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    const res = await fetch(`${admin}/admin/api/accounts`, adminWrite(etag, { activeProfileId: "team", profiles }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("account_unconfigured");
    expect((await (await fetch(`${admin}/admin/api/accounts`)).json()).activeProfileId).toBe("personal");
  });

  test("a stale If-Match is a revision conflict", async () => {
    const res = await fetch(`${admin}/admin/api/accounts`, adminWrite(`"accounts-v1-999"`, { activeProfileId: "personal", profiles }));
    expect(res.status).toBe(412);
  });

  test("invalid names are rejected with a plain error", async () => {
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    const res = await fetch(`${admin}/admin/api/accounts`, adminWrite(etag, { activeProfileId: "personal", profiles: [{ id: "personal", name: "   " }, { id: "team", name: "Team" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_accounts");
  });
});

describe("credential precedence on the wire", () => {
  test("with no request credential, upstream auth uses the active profile token", async () => {
    upstreamKeys.length = 0;
    const res = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
    expect([200, 400, 401, 502, 503].includes(res.status)).toBe(true);
    expect(upstreamKeys.length).toBeGreaterThan(0);
    expect(upstreamKeys[0]).toBe(`${SESSION_PREFIX}${PERSONAL}`);
  });

  test("an explicit request credential is used instead of the active profile", async () => {
    upstreamKeys.length = 0;
    await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${REQUEST}` }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
    expect(upstreamKeys.length).toBeGreaterThan(0);
    expect(upstreamKeys[0]).toBe(`${SESSION_PREFIX}${REQUEST}`);
  });

  test("after Team is enrolled and activated, the next request uses Team and the one before stays on Personal", async () => {
    await writeFile(join(configDir, "accounts", "team", "token"), `${TEAM}\n`, { recursive: true, mode: 0o600 }).catch(async () => {
      await mkdir(join(configDir, "accounts", "team"), { recursive: true, mode: 0o700 });
      await writeFile(join(configDir, "accounts", "team", "token"), `${TEAM}\n`, { mode: 0o600 });
    });
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    const switched = await fetch(`${admin}/admin/api/accounts`, adminWrite(etag, { activeProfileId: "team", profiles }));
    expect(switched.status).toBe(200);
    expect((await switched.json()).activeProfileId).toBe("team");
    upstreamKeys.length = 0;
    await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
    expect(upstreamKeys[0]).toBe(`${SESSION_PREFIX}${TEAM}`);
    expect(upstreamKeys).not.toContain(`${SESSION_PREFIX}${PERSONAL}`);
  });

  test("switching back to Personal restores the Personal token for the next request", async () => {
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    expect((await fetch(`${admin}/admin/api/accounts`, adminWrite(etag, { activeProfileId: "personal", profiles }))).status).toBe(200);
    upstreamKeys.length = 0;
    await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
    expect(upstreamKeys[0]).toBe(`${SESSION_PREFIX}${PERSONAL}`);
  });
  test("health reports only whether a fallback is set, never an account token", async () => {
    const text = await (await fetch(`${base}/health`)).text();
    for (const secret of [PERSONAL, TEAM, REQUEST]) expect(text).not.toContain(secret);
  });

  test("health reports only the credential state, with no account name or token", async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.fallback_token).toBe("set");
    expect(JSON.stringify(body)).not.toContain(PERSONAL);
  });
  test("the admin view follows a selection changed on disk, the same as inference", async () => {
    const stored = JSON.parse(await readFile(join(settingsDir, "accounts.json"), "utf8"));
    await writeFile(join(settingsDir, "accounts.json"), JSON.stringify({ ...stored, revision: stored.revision + 1, activeProfileId: "team" }) + "\n", { mode: 0o600 });
    const after = await (await fetch(`${admin}/admin/api/accounts`)).json();
    expect(after.activeProfileId).toBe("team");
    upstreamKeys.length = 0;
    await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "glm-5-3-flash-low", input: "synthetic", stream: false }) });
    expect(upstreamKeys[0]).toBe(`${SESSION_PREFIX}${TEAM}`);
    await writeFile(join(settingsDir, "accounts.json"), JSON.stringify(stored) + "\n", { mode: 0o600 });
    expect((await (await fetch(`${admin}/admin/api/accounts`)).json()).activeProfileId).toBe("personal");
  });

  test("the error trace label for an account request never contains the token", async () => {
    const res = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "not-a-real-model-xyz", input: "synthetic", stream: false }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await res.json())).not.toContain(PERSONAL);
  });
  test("account writes without the admin proxy secret are refused before the body is read", async () => {
    const etag = (await fetch(`${admin}/admin/api/accounts`)).headers.get("etag")!;
    const body = JSON.stringify({ activeProfileId: "personal", profiles });
    const base = { "content-type": "application/json", "x-devin-management": "1", "if-match": etag };
    const missingSecret = await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: base, body });
    expect(missingSecret.status).toBe(403);
    expect((await missingSecret.json()).error.code).toBe("admin_proxy_required");
    const wrongSecret = await fetch(`${admin}/admin/api/accounts`, { method: "PUT", headers: { ...base, "x-devin-admin-proxy": "0".repeat(64) }, body });
    expect(wrongSecret.status).toBe(403);
  });

  test("the admin proxy secret is never returned, and reads still work without it", async () => {
    const secret = (await readFile(join(settingsDir, "admin-proxy-secret"), "utf8")).trim();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    for (const path of ["/admin/api/accounts", "/admin/api/model-selection", "/admin/api/models"]) {
      const text = await (await fetch(`${admin}${path}`)).text();
      expect(text).not.toContain(secret);
    }
    expect((await fetch(`${admin}/admin/api/accounts`)).status).toBe(200);
  });

  test("the admin proxy secret file is owner-only and is reused across restarts", async () => {
    const path = join(settingsDir, "admin-proxy-secret");
    const first = await readFile(path, "utf8");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const { AdminProxySecret } = await import("../src/admin/proxy-secret.ts");
    const again = new AdminProxySecret(settingsDir);
    await again.initialize();
    expect(await readFile(path, "utf8")).toBe(first);
    expect(again.matches(first.trim())).toBe(true);
    expect(again.matches("x".repeat(64))).toBe(false);
    expect(again.matches(null)).toBe(false);
  });

  test("a malformed admin proxy secret is refused and not overwritten", async () => {
    const { AdminProxySecret } = await import("../src/admin/proxy-secret.ts");
    const dir = await mkdtemp(join(tmpdir(), "proxy-secret-bad-"));
    try {
      await writeFile(join(dir, "admin-proxy-secret"), "not-a-valid-secret\n", { mode: 0o600 });
      await expect(new AdminProxySecret(dir).initialize()).rejects.toThrow();
      expect(await readFile(join(dir, "admin-proxy-secret"), "utf8")).toBe("not-a-valid-secret\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("the accounts view reports staticOverride false here, with no secret or token", async () => {
    const text = await (await fetch(`${admin}/admin/api/accounts`)).text();
    const body = JSON.parse(text);
    expect(body.staticOverride).toBe(false);
    expect(text).not.toContain(PERSONAL);
    expect(text).not.toContain(proxySecretValue);
  });
  test("the saved token file is never rewritten by reads or failed switches", async () => {
    expect((await readFile(join(configDir, "token"), "utf8")).trim()).toBe(PERSONAL);
  });
});