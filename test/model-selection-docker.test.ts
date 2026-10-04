import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("Compose settings/auth volumes and login mounts remain separate", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const gateway = compose.split("  devin-gateway:")[1].split("  devin-login:")[0];
  const login = compose.split("  devin-login:")[1].split("\nvolumes:")[0];
  expect(gateway).toContain("- devin-gateway-auth:/home/gateway/.devin-gateway");
  expect(gateway).toContain("- devin-gateway-settings:/home/gateway/.devin-gateway-settings");
  expect(gateway).toContain('DEVIN_MODEL_SELECTION_ENABLED: "1"');
  expect(gateway).toContain('DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM: "1"');
  expect(login).toContain("- devin-gateway-auth:/home/gateway/.devin-gateway");
  expect(login).not.toContain("devin-gateway-settings");
  expect(compose.split("\nvolumes:")[1]).toContain("  devin-gateway-settings:");
  expect(gateway).toContain('DEVIN_ADMIN_PORT: "3001"');
  expect(gateway).toContain('DEVIN_ADMIN_HOST: "127.0.0.1"');
  expect(compose).not.toContain('DEVIN_ADMIN_PUBLIC_PORT');
  expect(compose).not.toContain('38644:3001');
  expect(gateway).toContain('}:38643:3000"');
  expect(gateway).toContain('}:443:443"');
  const proxy = compose.split("  devin-admin-proxy:")[1].split("  devin-login:")[0];
  expect(proxy).toContain("network_mode: service:devin-gateway");
  expect(proxy).not.toContain("ports:");
  expect(proxy).toContain("condition: service_healthy");
  expect(proxy).toContain("restart: true");
  expect(proxy).toContain("restart: unless-stopped");
  expect(proxy).toContain("devin-admin-caddy-data:/data");
  expect(proxy).toContain("devin-admin-caddy-config:/config");
  expect(proxy).not.toContain("devin-gateway-auth:");
  expect(proxy).not.toContain("devin-gateway-settings:");
});

test("image creates private settings owned by gateway; entrypoint does not touch auth", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const entrypoint = await readFile(new URL("../docker-entrypoint.sh", import.meta.url), "utf8");
  expect(dockerfile).toContain("chmod 700 /home/gateway/.devin-gateway-settings");
  expect(entrypoint).toContain('chown gateway:gateway "$SETTINGS_DIR"');
  expect(entrypoint).toContain('chmod 700 "$SETTINGS_DIR"');
  expect(entrypoint).not.toMatch(/(?:chmod|chown|rm).*\$AUTH_DIR/);
  expect(entrypoint).toContain("exec su-exec gateway bun run src/index.ts");
});
