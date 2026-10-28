import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAdminStaticHandler } from "../src/admin/static.ts";
import { startServer } from "../src/server.ts";
test("static assets use a fixed allowlist, same-origin CSP and no executable inline content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "picker-assets-"));
  try {
    await writeFile(join(directory, "index.html"), "<!doctype html><title>Synthetic picker</title>");
    await writeFile(join(directory, "model-picker.js"), "/* synthetic asset */");
    const serve = createAdminStaticHandler(pathToFileURL(directory + "/"));
    const response = await serve(new Request("http://127.0.0.1:3001/admin/"));
    expect(response?.status).toBe(200); expect(response?.headers.get("content-type")).toContain("text/html");
    const csp = response?.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self'"); expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline"); expect(csp).not.toContain("unsafe-eval");
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
    expect(await serve(new Request("http://127.0.0.1:3001/admin/assets/../../config.ts"))).toBeNull();
    expect(await serve(new Request("http://127.0.0.1:3001/admin/assets/.env"))).toBeNull();
    expect((await serve(new Request("http://127.0.0.1:3001/admin/", { method: "POST" })))?.status).toBe(405);
    expect(await (await serve(new Request("http://127.0.0.1:3001/admin/", { method: "HEAD" })))?.text()).toBe("");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("missing static build returns sanitized 503 without affecting API routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "picker-missing-"));
  try {
    const serve = createAdminStaticHandler(pathToFileURL(directory + "/"));
    const response = await serve(new Request("http://127.0.0.1:3001/admin/"));
    expect(response?.status).toBe(503); expect(await response?.text()).not.toContain(directory);
    expect(await serve(new Request("http://127.0.0.1:3001/admin/api/models"))).toBeNull();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("page and assets remain blocked on inference and guarded on management", async () => {
  const directory = await mkdtemp(join(tmpdir(), "picker-isolation-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
  const port = probe.port!; await probe.stop(true);
  const signals = ["SIGTERM", "SIGINT"] as const;
  const before = Object.fromEntries(signals.map((signal) => [signal, process.listeners(signal)]));
  const gateway = await startServer({ port, host: "127.0.0.1", token: "", modelSelection: { directory, adminPort: 0 } });
  try {
    for (const path of ["/admin/", "/admin/assets/model-picker.js", "/admin/assets/model-picker.css"]) {
      expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${gateway.adminPort}${path}`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    }
    expect([200, 503]).toContain((await fetch(`http://127.0.0.1:${gateway.adminPort}/admin/`)).status);
    expect((await fetch(`http://127.0.0.1:${gateway.adminPort}/admin/api/model-selection`)).status).toBe(200);
  } finally {
    await gateway.stop(); for (const signal of signals) for (const listener of process.listeners(signal)) if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    await rm(directory, { recursive: true, force: true });
  }
});
