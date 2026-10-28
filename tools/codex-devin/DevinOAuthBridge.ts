import { createServer, type Server } from "node:http";
import { completeLoginWithUrl, startLoginFlow, type LoginSession } from "../../src/login.js";
import { startServer, type ServerHandle, type ServerOptions } from "../../src/server.js";

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_PORT = 59653;
const DEFAULT_GATEWAY_PORT = 38643;
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000;

export interface MemoryOnlyOAuthOptions {
  callbackPort?: number;
  gatewayPort?: number;
  timeoutMs?: number;
}

export interface MemoryOnlyOAuthDependencies {
  startLoginFlow: (redirectUri: string) => Promise<LoginSession>;
  completeLoginWithUrl: (session: LoginSession, redirectUrl: string) => Promise<string>;
  startGateway: (options: ServerOptions) => Promise<ServerHandle>;
  writeLine: (line: string) => void;
}

const runtimeDependencies: MemoryOnlyOAuthDependencies = {
  startLoginFlow,
  completeLoginWithUrl,
  startGateway: startServer,
  writeLine: (line) => console.log(line),
};

/**
 * Run PKCE OAuth on loopback and pass the returned token directly to the clean
 * fork's server runtime. This helper intentionally has no credential-file API.
 */
export async function runMemoryOnlyOAuthGateway(
  options: MemoryOnlyOAuthOptions = {},
  dependencies: MemoryOnlyOAuthDependencies = runtimeDependencies,
): Promise<ServerHandle> {
  const callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const gatewayPort = options.gatewayPort ?? DEFAULT_GATEWAY_PORT;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  assertPort(callbackPort, "callbackPort");
  assertPort(gatewayPort, "gatewayPort");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be positive.");

  const redirectUri = `http://${CALLBACK_HOST}:${callbackPort}${CALLBACK_PATH}`;
  const session = await dependencies.startLoginFlow(redirectUri);

  return await new Promise<ServerHandle>((resolve, reject) => {
    let settled = false;
    let callbackServer: Server;

    const settleFailure = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callbackServer.close();
      reject(new Error(message));
    };

    const timeout = setTimeout(() => settleFailure("Devin sign-in timed out."), timeoutMs);

    callbackServer = createServer((request, response) => {
      let callbackUrl: URL;
      try {
        callbackUrl = new URL(request.url ?? "/", redirectUri);
      } catch {
        response.writeHead(400).end("Invalid sign-in callback.");
        return;
      }
      if (callbackUrl.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end("Not Found");
        return;
      }
      if (callbackUrl.searchParams.has("error")) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Devin sign-in was not completed. You may close this tab.");
        settleFailure("Devin sign-in was not completed.");
        return;
      }
      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");
      if (!code || state !== session.state) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("Invalid or expired sign-in callback. Start a fresh login flow.");
        return;
      }
      if (settled) {
        response.writeHead(409).end("This sign-in flow has already completed.");
        return;
      }

      settled = true;
      void completeLoginAndStartGateway(session, callbackUrl, dependencies, gatewayPort)
        .then((gateway) => {
          clearTimeout(timeout);
          callbackServer.close();
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          response.end("Devin sign-in succeeded. You may close this tab.");
          dependencies.writeLine("DEVIN_OAUTH=code_exchange_succeeded; credential_storage=memory_only; debug=off; error_trace=off");
          dependencies.writeLine(`LOCAL_GATEWAY=http://${CALLBACK_HOST}:${gateway.port}; server_handle=${Boolean(gateway)}`);
          const diagnosticsEnabled = process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS === "1";
          dependencies.writeLine(`SAFE_DIAGNOSTICS=${diagnosticsEnabled ? "enabled" : "disabled"}; raw_logging=off`);
          resolve(gateway);
        })
        .catch(() => {
          clearTimeout(timeout);
          callbackServer.close();
          response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          response.end("Devin sign-in could not be verified. No credential was saved or printed.");
          dependencies.writeLine("DEVIN_OAUTH=failed; credential_storage=memory_only; details_withheld");
          reject(new Error("Devin OAuth exchange or gateway startup failed; details withheld."));
        });
    });

    callbackServer.once("error", () => settleFailure("The loopback OAuth callback listener could not start."));
    callbackServer.once("listening", () => {
      dependencies.writeLine("Fresh Devin sign-in URL (one-time OAuth flow):");
      dependencies.writeLine(session.authUrl);
      dependencies.writeLine(`Waiting for callback on ${redirectUri}; timeout=${Math.floor(timeoutMs / 60_000)}m.`);
    });
    callbackServer.listen(callbackPort, CALLBACK_HOST);
  });
}

async function completeLoginAndStartGateway(
  session: LoginSession,
  callbackUrl: URL,
  dependencies: MemoryOnlyOAuthDependencies,
  gatewayPort: number,
): Promise<ServerHandle> {
  const token = await dependencies.completeLoginWithUrl(session, callbackUrl.toString());
  return dependencies.startGateway({ host: CALLBACK_HOST, port: gatewayPort, token });
}

function assertPort(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be a valid unprivileged TCP port.`);
  }
}

if (import.meta.main) {
  const gatewayPort = Number(process.env.DEVIN_GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT);
  try {
    await runMemoryOnlyOAuthGateway({ gatewayPort });
    console.log("READY_FOR_CODEX_DESKTOP_TEST; keep this process open until validation is complete.");
    await new Promise<void>(() => {});
  } catch {
    console.error("DEVIN_OAUTH=failed; credential_storage=memory_only; details_withheld");
    process.exitCode = 1;
  }
}
