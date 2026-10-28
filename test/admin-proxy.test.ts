import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const read = (file: string) => readFile(new URL("../" + file, import.meta.url), "utf8");

test("Nginx authenticates and validates externally before translating to the unchanged backend", async () => {
  const config = await read("deploy/nginx-devin-admin.conf");
  expect(config).toContain("server_name admin.example.test;");
  expect(config).toContain("/etc/letsencrypt/live/example.test/fullchain.pem");
  expect(config).toContain("satisfy all;");
  expect(config).toContain("allow 192.0.2.0/24;");
  expect(config).toContain("allow 198.51.100.0/24;");
  expect(config).toContain("deny all;");
  expect(config).toContain("auth_basic_user_file /etc/nginx/auth/devin-admin.htpasswd;");
  expect(config).toContain('if ($http_host != "admin.example.test") { return 403; }');
  expect(config).toContain('"https://admin.example.test" "http://127.0.0.1:3001";');
  expect(config).toContain("if ($devin_admin_origin = forbidden) { return 403; }");
  expect(config).toContain("if ($devin_admin_site_allowed = 0) { return 403; }");
  expect(config).toContain('proxy_set_header Host "127.0.0.1:3001";');
  for (const name of ["Authorization", "Cookie", "X-Api-Key"]) {
    expect(config).toContain(`proxy_set_header ${name} "";`);
  }
  expect(config).toContain("location / { return 404; }");
  expect(config).toContain("limit_except GET PUT { deny all; }");
  expect(config).toContain("proxy_set_header X-Devin-Admin-Proxy \"\";");
  expect(config).toContain("include /etc/nginx/devin-admin-proxy-secret.conf;");
  expect(config).toContain("api/(?:models|model-selection|model-test-status|accounts)$");
  expect(config).toContain("assets/(?:model-picker\\.js|model-picker\\.css|third-party-notices\\.txt)$");
  expect(config).not.toContain("38643");
});

test("persistent firewall rejects non-proxy original destinations before Docker's broad rules", async () => {
  const script = await read("scripts/devin-admin-firewall.sh");
  expect(script).toContain("for chain in DOCKER-USER INPUT PREROUTING");
  expect(script).toContain('--ctorigdst "$gateway_ip" --ctorigdstport 38644');
  expect(script).toContain('! -s "$proxy_ip" -j DROP');
  expect(script).not.toContain("-F ");
  const hook = await read("deploy/20-devin-admin-firewall.conf");
  expect(hook).toContain("ExecStartPost=/usr/local/sbin/devin-admin-firewall");
  expect(hook).toContain("Requires=devin-admin-firewall.service");
  const unit = await read("deploy/devin-admin-firewall.service");
  expect(unit).toContain("Before=docker.service");
  expect(unit).toContain("After=ufw.service");
});

test("private credentials never enter Compose or image build context", async () => {
  for (const file of [".gitignore", ".dockerignore"]) expect(await read(file)).toContain("secrets/");
  const compose = await read("docker-compose.yml");
  expect(compose).not.toContain("htpasswd");
  expect(compose).not.toContain("secrets:");
  expect(compose).not.toContain("PASSWORD:");
});
