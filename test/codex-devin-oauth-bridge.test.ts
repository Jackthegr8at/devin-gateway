import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginSession } from "../src/login.js";
import type { ServerHandle } from "../src/server.js";
import { runMemoryOnlyOAuthGateway } from "../tools/codex-devin/DevinOAuthBridge.ts";

async function getUnusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback test listener did not bind.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function listRelativeFiles(root: string, current = root): string[] {
  return readdirSync(current).flatMap((name) => {
    const fullPath = join(current, name);
    return statSync(fullPath).isDirectory()
      ? listRelativeFiles(root, fullPath)
      : [fullPath.slice(root.length + 1)];
  }).sort();
}

describe("clean-fork memory-only OAuth helper", () => {
  test("passes the fresh OAuth token directly to the gateway and creates no credential files", async () => {
    const home = mkdtempSync(join(tmpdir(), "devin-gateway-oauth-home-"));
    const envNames = ["HOME", "USERPROFILE", "CODEX_HOME", "DEVIN_GATEWAY_CONFIG_DIR", "DEVIN_RESPONSES_SAFE_DIAGNOSTICS"] as const;
    const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CODEX_HOME = join(home, ".codex");
    process.env.DEVIN_GATEWAY_CONFIG_DIR = join(home, ".devin-gateway");
    process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS = "1";

    const callbackPort = await getUnusedLoopbackPort();
    const gatewayPort = await getUnusedLoopbackPort();
    const fakeToken = "synthetic-oauth-secret-for-test-only";
    const session: LoginSession = {
      state: "synthetic-state",
      verifier: "synthetic-verifier",
      challenge: "synthetic-challenge",
      authUrl: "https://signin.invalid/one-time-test-flow",
      redirectUri: "",
    };
    const logLines: string[] = [];
    let resolveCallbackListening!: () => void;
    const callbackListening = new Promise<void>((resolve) => { resolveCallbackListening = resolve; });
    let redirectUri = "";
    let receivedToken = "";
    let gatewayOptions: { host?: string; port?: number; token?: string } | undefined;
    const writeLine = (line: string): void => {
      logLines.push(line);
      if (line.startsWith("Waiting for callback on http://127.0.0.1:")) resolveCallbackListening();
    };
    const beforeFiles = listRelativeFiles(home);

    try {
      const gatewayPromise = runMemoryOnlyOAuthGateway(
        { callbackPort, gatewayPort, timeoutMs: 5_000 },
        {
          startLoginFlow: async (uri) => {
            redirectUri = uri;
            session.redirectUri = uri;
            return session;
          },
          completeLoginWithUrl: async (_loginSession, url) => {
            expect(new URL(url).searchParams.get("code")).toBe("synthetic-code");
            return fakeToken;
          },
          startGateway: async (options) => {
            receivedToken = options.token ?? "";
            gatewayOptions = options;
            const handle: ServerHandle = { host: options.host!, port: options.port!, stop: async () => {} };
            return handle;
          },
          writeLine: (line) => writeLine(line),
        },
      );

      await callbackListening;
      const callback = await fetch(`${redirectUri}?code=synthetic-code&state=synthetic-state`);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("sign-in succeeded");
      const gateway = await gatewayPromise;

      expect(gateway.host).toBe("127.0.0.1");
      expect(gateway.port).toBe(gatewayPort);
      expect(receivedToken).toBe(fakeToken);
      expect(gatewayOptions).toEqual({ host: "127.0.0.1", port: gatewayPort, token: fakeToken });
      expect(logLines.join("\n")).not.toContain(fakeToken);
      expect(logLines).toContain("SAFE_DIAGNOSTICS=enabled; raw_logging=off");
      expect(listRelativeFiles(home)).toEqual(beforeFiles);

      const helperSource = readFileSync(new URL("../tools/codex-devin/DevinOAuthBridge.ts", import.meta.url), "utf8");
      expect(helperSource).not.toMatch(/writeToken|TOKEN_FILE|writeFileSync|writeFile\s*\(|appendFileSync|openSync/);
    } finally {
      for (const name of envNames) {
        const value = oldEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
