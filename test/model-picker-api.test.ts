import { describe, expect, test } from "bun:test";
import { createPickerApi } from "../web/model-picker/api.ts";
import { initialModelSelection } from "../src/admin/model-selection.ts";
describe("management-only browser API", () => {
  test("parallel GET load uses exact selection ETag and no client credentials", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const api = createPickerApi((async (path, init) => {
      calls.push({ path: String(path), init: init! });
      return String(path).endsWith("/models") ? Response.json({ source: "remote", selectionRevision: 1, models: [] })
        : Response.json(initialModelSelection(), { headers: { etag: '"model-selection-v1-1"' } });
    }) as typeof fetch);
    expect((await api.load()).etag).toBe('"model-selection-v1-1"');
    expect(calls.map((call) => call.path).sort()).toEqual(["/admin/api/model-selection", "/admin/api/models"]);
    for (const { init } of calls) { expect(init.credentials).toBe("omit"); expect(init.mode).toBe("same-origin"); expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal); }
  });
  test("Save sends the complete draft, ETag and explicit CSRF management header only once", async () => {
    let calls = 0;
    const api = createPickerApi((async (path, init) => {
      calls++; expect(path).toBe("/admin/api/model-selection"); expect(init?.method).toBe("PUT");
      const headers = new Headers(init?.headers);
      expect(headers.get("if-match")).toBe('"model-selection-v1-1"'); expect(headers.get("x-devin-management")).toBe("1");
      expect(headers.get("content-type")).toBe("application/json"); expect(headers.has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual(initialModelSelection());
      return Response.json({ ...initialModelSelection(), revision: 2 }, { headers: { etag: '"model-selection-v1-2"' } });
    }) as typeof fetch);
    expect((await api.save(initialModelSelection(), '"model-selection-v1-1"')).selection.revision).toBe(2); expect(calls).toBe(1);
  });
  test("412 is surfaced without retrying, overwriting or exposing arbitrary backend error text", async () => {
    let calls = 0;
    const api = createPickerApi((async () => { calls++; return Response.json({ error: "SYNTHETIC_PRIVATE_BACKEND_VALUE" }, { status: 412 }); }) as typeof fetch);
    await expect(api.save(initialModelSelection(), '"model-selection-v1-1"')).rejects.toMatchObject({ status: 412 });
    expect(calls).toBe(1);
    try { await api.save(initialModelSelection(), '"model-selection-v1-1"'); } catch (error) { expect(String(error)).not.toContain("SYNTHETIC_PRIVATE"); }
  });
  test("inconsistent GET revisions, corrupt response and invalid ETag fail closed", async () => {
    for (const variant of ["revision", "etag", "json"]) {
      const api = createPickerApi((async (path) => String(path).endsWith("/models")
        ? Response.json({ source: "remote", selectionRevision: variant === "revision" ? 2 : 1, models: [] })
        : variant === "json" ? new Response("invalid", { status: 200 })
        : Response.json(initialModelSelection(), { headers: { etag: variant === "etag" ? "wrong" : '"model-selection-v1-1"' } })) as typeof fetch);
      await expect(api.load()).rejects.toBeInstanceOf(Error);
    }
  });
  test("network failures retain a safe recovery message, not raw network data", async () => {
    const api = createPickerApi((async () => { throw new Error("SYNTHETIC_NETWORK_SECRET"); }) as typeof fetch);
    await expect(api.load()).rejects.toThrow("SSH tunnel");
  });
});
