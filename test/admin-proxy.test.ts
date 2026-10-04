import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("proxy uses exact admin resources and validates externally before authenticating/translating", async () => {
  const config = await readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  const paths = config.match(/@admin_resources path ([^\r\n]+)/)![1].split(" ");
  expect(paths).toEqual(["/admin/", "/admin/api/models", "/admin/api/model-selection",
    "/admin/api/model-test-status", "/admin/assets/model-picker.js",
    "/admin/assets/model-picker.css", "/admin/assets/third-party-notices.txt"]);
  expect(config).toContain("admin off");
  expect(config).toContain("auto_https disable_redirects");
  expect(config).toContain("tls internal");
  expect(config).toContain("@wrong_host");
  expect(config).toContain("not header Origin https://devin-admin.home.arpa");
  expect(config).toContain("!header({'Sec-Fetch-Site': ['same-origin', 'none']})");
  expect(config.indexOf("respond @foreign_origin")).toBeLessThan(config.indexOf("request_header @present_origin"));
  expect(config.indexOf("basic_auth")).toBeLessThan(config.indexOf("reverse_proxy"));
  expect(config).toContain("request_header @present_origin Origin http://127.0.0.1:3001");
  expect(config).toContain("header_up Host 127.0.0.1:3001");
  for (const name of ["Authorization", "Cookie", "X-Api-Key"]) expect(config).toContain("header_up -" + name);
  expect(config).toContain('respond "Not found" 404');
  expect(config).not.toContain("38643");
});

test("private admin credentials cannot enter Git or Docker build context", async () => {
  for (const file of [".gitignore", ".dockerignore"]) {
    expect(await readFile(new URL("../" + file, import.meta.url), "utf8")).toContain("secrets/");
  }
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  expect(compose).toContain("file: ./secrets/devin-admin-users.caddy");
  expect(compose).not.toContain("PASSWORD:");
  expect(compose).not.toContain("hash-password");
});
