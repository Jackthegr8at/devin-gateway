import { describe, expect, test } from "bun:test";
import { ACCOUNTS_MESSAGES, AccountsApiError, createAccountsApi } from "../web/model-picker/accounts.ts";

const SECRET = "SYNTHETIC_TOKEN_VALUE_DO_NOT_SHOW";
const goodBody = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, revision: 4, activeProfileId: "personal", staticOverride: false,
  profiles: [
    { id: "personal", name: "Synthetic Personal", credentialState: "configured" },
    { id: "team", name: "Synthetic Team", credentialState: "unconfigured" },
  ],
  ...overrides,
});
const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);
const withEtag = (body: unknown, revision = 4) => json(body, { headers: { etag: `"accounts-v1-${revision}"` } });
function withoutStaticOverride(): Record<string, unknown> {
  const body: Record<string, unknown> = goodBody();
  delete body.staticOverride;
  return body;
}
function recorder(respond: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { path: string; init: RequestInit }[] = [];
  const send = (async (path: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: String(path), init: init ?? {} });
    return respond(String(path), init ?? {});
  }) as typeof fetch;
  return { send, calls };
}
async function failure(promise: Promise<unknown>): Promise<AccountsApiError> {
  try { await promise; } catch (error) { if (error instanceof AccountsApiError) return error; throw error; }
  throw new Error("Expected the promise to reject");
}

describe("accounts GET parsing", () => {
  test("parses the contract into names and state with same-origin, no-store fetch options", async () => {
    const { send, calls } = recorder(() => withEtag(goodBody()));
    const snapshot = await createAccountsApi(send).load();
    expect(snapshot).toEqual({
    revision: 4, etag: '"accounts-v1-4"', activeProfileId: "personal", staticOverride: false,
      profiles: [
        { id: "personal", name: "Synthetic Personal", credentialState: "configured" },
        { id: "team", name: "Synthetic Team", credentialState: "unconfigured" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/admin/api/accounts");
    expect(calls[0].init.method).toBeUndefined();
    expect(calls[0].init).toMatchObject({ mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("accepts each credential state, including invalid, and both active profiles", async () => {
    const { send } = recorder(() => withEtag(goodBody({
      activeProfileId: "team",
      profiles: [
        { id: "personal", name: "A", credentialState: "invalid" },
        { id: "team", name: "B", credentialState: "configured" },
      ],
    })));
    const snapshot = await createAccountsApi(send).load();
    expect(snapshot.activeProfileId).toBe("team");
    expect(snapshot.profiles.map((profile) => profile.credentialState)).toEqual(["invalid", "configured"]);
  });

  test.each([[true], [false]])("accepts staticOverride %p and keeps the boolean", async (value) => {
    const { send } = recorder(() => withEtag(goodBody({ staticOverride: value })));
    const snapshot = await createAccountsApi(send).load();
    expect(snapshot.staticOverride).toBe(value);
  });

  test("drops every field outside the allowlist, so token-like values never reach the client", async () => {
    const body = goodBody({ token: SECRET, activeCredential: { apiKey: SECRET } });
    body.profiles[0] = { ...body.profiles[0], token: SECRET, credential: { refreshToken: SECRET } } as never;
    const { send } = recorder(() => withEtag(body));
    const snapshot = await createAccountsApi(send).load();
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(Object.keys(snapshot).sort()).toEqual(["activeProfileId", "etag", "profiles", "revision", "staticOverride"]);
    for (const profile of snapshot.profiles) expect(Object.keys(profile).sort()).toEqual(["credentialState", "id", "name"]);
  });

  test.each([
    ["wrong schema version", goodBody({ schemaVersion: 2 })],
    ["unknown active profile", goodBody({ activeProfileId: "work" })],
    ["profiles out of order", goodBody({ profiles: [goodBody().profiles[1], goodBody().profiles[0]] })],
    ["a missing profile", goodBody({ profiles: [goodBody().profiles[0]] })],
    ["an extra profile", goodBody({ profiles: [...goodBody().profiles, { id: "personal", name: "X", credentialState: "configured" }] })],
    ["an unknown credential state", goodBody({ profiles: [{ id: "personal", name: "A", credentialState: "expired" }, goodBody().profiles[1]] })],
    ["an empty name", goodBody({ profiles: [{ id: "personal", name: "  ", credentialState: "configured" }, goodBody().profiles[1]] })],
    ["a non-string name", goodBody({ profiles: [{ id: "personal", name: 7, credentialState: "configured" }, goodBody().profiles[1]] })],
    ["a non-integer revision", goodBody({ revision: 1.5 })],
    ["a negative revision", goodBody({ revision: -1 })],
    ["a missing staticOverride", withoutStaticOverride()],
    ["a string staticOverride", goodBody({ staticOverride: "true" })],
    ["a numeric staticOverride", goodBody({ staticOverride: 1 })],
    ["a null staticOverride", goodBody({ staticOverride: null })],
    ["an array body", []],
    ["a null body", null],
  ])("rejects a body with %s", async (_label, body) => {
    const { send } = recorder(() => withEtag(body));
    const error = await failure(createAccountsApi(send).load());
    expect(error.message).toBe(ACCOUNTS_MESSAGES.invalidData);
    expect(error.status).toBe(0);
  });

  test("rejects a missing or mismatched ETag", async () => {
    for (const response of [json(goodBody()), json(goodBody(), { headers: { etag: '"accounts-v1-5"' } }), json(goodBody(), { headers: { etag: "accounts-v1-4" } })]) {
      const error = await failure(createAccountsApi(recorder(() => response).send).load());
      expect(error.message).toBe(ACCOUNTS_MESSAGES.invalidData);
    }
  });

  test("rejects a non-JSON 200 body without echoing it", async () => {
    const error = await failure(createAccountsApi(recorder(() => new Response(`not json ${SECRET}`, { status: 200 })).send).load());
    expect(error.message).toBe(ACCOUNTS_MESSAGES.invalidData);
    expect(error.message).not.toContain(SECRET);
  });
});

describe("accounts PUT request", () => {
  test("sends the required management headers, If-Match, and the full object with trimmed names", async () => {
    const { send, calls } = recorder(() => withEtag(goodBody({ revision: 5 }), 5));
    const api = createAccountsApi(send);
    const snapshot = await api.save({
      activeProfileId: "personal",
      profiles: [{ id: "team", name: "  Renamed Team  " }, { id: "personal", name: "Synthetic Personal" }],
    }, '"accounts-v1-4"');
    expect(snapshot.etag).toBe('"accounts-v1-5"');
    expect(calls).toHaveLength(1);
    const { path, init } = calls[0];
    expect(path).toBe("/admin/api/accounts");
    expect(init.method).toBe("PUT");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-devin-management")).toBe("1");
    expect(headers.get("if-match")).toBe('"accounts-v1-4"');
    expect(headers.has("authorization")).toBe(false);
    expect(init).toMatchObject({ mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toEqual({
      activeProfileId: "personal",
      profiles: [{ id: "personal", name: "Synthetic Personal" }, { id: "team", name: "Renamed Team" }],
    });
  });

  test("refuses to send when the ETag or a name is not usable, without calling fetch", async () => {
    const { send, calls } = recorder(() => withEtag(goodBody()));
    const api = createAccountsApi(send);
    const update = { activeProfileId: "personal" as const, profiles: [{ id: "personal" as const, name: "A" }, { id: "team" as const, name: "B" }] };
    expect((await failure(api.save(update, "accounts-v1-4"))).message).toBe(ACCOUNTS_MESSAGES.update);
    expect((await failure(api.save(update, '"model-selection-v2-4"'))).message).toBe(ACCOUNTS_MESSAGES.update);
    const blank = { ...update, profiles: [{ id: "personal" as const, name: "   " }, { id: "team" as const, name: "B" }] };
    expect((await failure(api.save(blank, '"accounts-v1-4"'))).message).toBe(ACCOUNTS_MESSAGES.emptyName);
    expect(calls).toHaveLength(0);
  });

  test("a successful save with a malformed response fails closed", async () => {
    const { send } = recorder(() => json(goodBody()));
    const error = await failure(createAccountsApi(send).save({ activeProfileId: "personal", profiles: [{ id: "personal", name: "A" }, { id: "team", name: "B" }] }, '"accounts-v1-4"'));
    expect(error.message).toBe(ACCOUNTS_MESSAGES.invalidData);
  });
});

describe("accounts error mapping", () => {
  const update = { activeProfileId: "team" as const, profiles: [{ id: "personal" as const, name: "A" }, { id: "team" as const, name: "B" }] };

  test("409 account_unconfigured shows the server message and status", async () => {
    const { send } = recorder(() => json({ error: { code: "account_unconfigured", message: "Team is not signed in." } }, { status: 409 }));
    const error = await failure(createAccountsApi(send).save(update, '"accounts-v1-4"'));
    expect(error.status).toBe(409);
    expect(error.code).toBe("account_unconfigured");
    expect(error.message).toBe("Team is not signed in.");
  });

  test("409 account_unconfigured without a usable message falls back to fixed copy", async () => {
    const { send } = recorder(() => json({ error: { code: "account_unconfigured", message: SECRET + "x".repeat(300) } }, { status: 409 }));
    const error = await failure(createAccountsApi(send).save(update, '"accounts-v1-4"'));
    expect(error.message).toBe(ACCOUNTS_MESSAGES.unconfigured);
    expect(error.message).not.toContain(SECRET);
  });

  test("400 invalid_accounts shows the server message only when it is short plain text", async () => {
    const short = recorder(() => json({ error: { code: "invalid_accounts", message: "Names must be 1 to 64 characters." } }, { status: 400 }));
    expect((await failure(createAccountsApi(short.send).save(update, '"accounts-v1-4"'))).message).toBe("Names must be 1 to 64 characters.");
    const long = recorder(() => json({ error: { code: "invalid_accounts", message: "x".repeat(500) } }, { status: 400 }));
    expect((await failure(createAccountsApi(long.send).save(update, '"accounts-v1-4"'))).message).toBe(ACCOUNTS_MESSAGES.invalidNames);
  });

  test("400 with another code is generic", async () => {
    const { send } = recorder(() => json({ error: { code: "bad_request", message: SECRET } }, { status: 400 }));
    const error = await failure(createAccountsApi(send).save(update, '"accounts-v1-4"'));
    expect(error.message).toBe(ACCOUNTS_MESSAGES.update);
    expect(error.message).not.toContain(SECRET);
  });

  test("412 revision_conflict is reported as a conflict with status 412 and no server text", async () => {
    const { send } = recorder(() => json({ error: { code: "revision_conflict", message: SECRET } }, { status: 412 }));
    const error = await failure(createAccountsApi(send).save(update, '"accounts-v1-4"'));
    expect(error.status).toBe(412);
    expect(error.code).toBe("revision_conflict");
    expect(error.message).toBe(ACCOUNTS_MESSAGES.conflict);
  });

  test("503 accounts_unavailable is generic on load and save", async () => {
    const unavailable = () => recorder(() => json({ error: { code: "accounts_unavailable", message: SECRET } }, { status: 503 })).send;
    expect((await failure(createAccountsApi(unavailable()).load())).message).toBe(ACCOUNTS_MESSAGES.unavailable);
    expect((await failure(createAccountsApi(unavailable()).save(update, '"accounts-v1-4"'))).message).toBe(ACCOUNTS_MESSAGES.unavailable);
  });

  test.each([415, 428, 403, 500])("HTTP %i is generic and does not echo the body", async (status) => {
    const { send } = recorder(() => json({ error: { code: "other", message: SECRET } }, { status }));
    const error = await failure(createAccountsApi(send).save(update, '"accounts-v1-4"'));
    expect(error.status).toBe(status);
    expect(error.message).toBe(ACCOUNTS_MESSAGES.update);
    expect(error.message).not.toContain(SECRET);
    const loadError = await failure(createAccountsApi(recorder(() => new Response(SECRET, { status })).send).load());
    expect(loadError.message).toBe(ACCOUNTS_MESSAGES.load);
  });

  test("a network failure gives the reachable-gateway copy and hides the raw error", async () => {
    const send = (async () => { throw new Error(SECRET); }) as typeof fetch;
    const error = await failure(createAccountsApi(send).load());
    expect(error.message).toBe(ACCOUNTS_MESSAGES.network);
    expect(error.message).not.toContain(SECRET);
    expect((await failure(createAccountsApi(send).save(update, '"accounts-v1-4"'))).message).toBe(ACCOUNTS_MESSAGES.network);
  });
});
