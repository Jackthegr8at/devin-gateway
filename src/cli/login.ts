#!/usr/bin/env node
/**
 * devin-gateway login CLI.
 *
 * Runs the Devin OAuth PKCE flow on a local callback server, then saves the
 * token for one account profile:
 *   personal (default) -> $DEVIN_GATEWAY_CONFIG_DIR/token (legacy file)
 *   team               -> $DEVIN_GATEWAY_CONFIG_DIR/accounts/team/token
 * The config directory defaults to ~/.devin-gateway.
 *
 * Runtime: works under both Node.js (>=20) and Bun — uses only `node:http`,
 * `node:readline`, `node:child_process`, and the Web Crypto/fetch globals.
 *
 * Usage:
 *   devin-gateway login                      # interactive — opens browser (personal)
 *   devin-gateway login --profile team       # interactive — sign in the team profile
 *   devin-gateway login --paste              # paste redirect URL manually
 *   devin-gateway login --print              # print token only, don't save (not with --profile)
 *   devin-gateway login --no-display-token   # save token without printing it
 *   devin-gateway login --replace            # overwrite an existing sign-in for the target profile
 *   devin-gateway login --status             # profile name, credential state, and token file path
 *
 * Profile logins never print the token.
 *
 * Also runnable directly:
 *   bun run src/cli/login.ts
 *   node src/cli/login.ts --status
 */
import { exec } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { startLoginFlow, completeLoginWithUrl, exchangeToken, TOKEN_EXCHANGE_TIMEOUT_MS } from "../login.js";
import { CONFIG_DIR } from "../config.js";
import { AccountStore, defaultProfileName } from "../accounts/account-store.js";
import {
  ACCOUNT_PROFILE_IDS,
  isAccountProfileId,
  profileCredentialState,
  profileTokenPath,
  writeProfileCredential,
  type AccountProfileId,
  type CredentialState,
} from "../accounts/profiles.js";
import { defaultSettingsDirectory } from "../admin/model-selection-store.js";
import { normalizedErrorMessage } from "../responses-diagnostics.js";

const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const TIMEOUT_MS = 5 * 60 * 1000;

export async function runLogin(argv: string[]): Promise<void> {
  const parsed = parseLoginArguments(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    process.exit(1);
  }
  const options = parsed.options;
  const pasteMode = options.paste;
  const printOnly = options.print;
  const profile = options.profile;

  // ─── Status ──────────────────────────────────────────────────────────────────
  if (options.status) {
    await printProfileStatus(profile);
    return;
  }

  // ─── Replace guard ───────────────────────────────────────────────────────────
  // --print saves nothing, so only a save is refused.
  if (!printOnly) {
    const refusal = await existingSignInRefusal(CONFIG_DIR, profile, { replace: options.replace });
    if (refusal !== undefined) {
      console.error(refusal);
      process.exit(1);
    }
  }

  // ─── Login flow ──────────────────────────────────────────────────────────────
  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const session = await startLoginFlow(redirectUri);

  console.log("");
  console.log("  Devin Gateway — Login");
  console.log("  ─────────────────────────────────────────────────────");
  console.log("");
  console.log("  Open this URL in your browser to sign in to Devin:");
  console.log("");
  console.log(`  ${session.authUrl}`);
  console.log("");

  if (pasteMode) {
    // Manual paste mode: no local server, user pastes the redirect URL
    console.log("  After signing in, you'll be redirected to a URL like:");
    console.log(`  http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}?code=...&state=...`);
    console.log("  Paste that full URL here:");
    console.log("");

    const input = await prompt("  > ");
    if (!input) {
      console.error("No URL provided.");
      process.exit(1);
    }

    try {
      console.log(`  Callback received. Contacting Devin to exchange the code (${TOKEN_EXCHANGE_TIMEOUT_MS / 1000}s timeout)...`);
      const token = await completeLoginWithUrl(session, input.trim());
      await finishLogin(token, options);
    } catch (err) {
      console.error(`Login failed: ${String((err as Error).message ?? err)}`);
      process.exit(1);
    }
  } else {
    // Auto mode: start local callback server, wait for it to be listening, then
    // open the browser — so the callback URL is reachable the instant it loads.
    const { ready, token } = startCallbackServer(session);

    try {
      await ready; // throws on EADDRINUSE / other listen failures
    } catch (err) {
      console.error(`Login failed: ${String((err as Error).message ?? err)}`);
      process.exit(1);
    }

    // Try to open the browser automatically
    try {
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? `cmd /c start ""`
            : "xdg-open";
      execAsync(`${cmd} "${session.authUrl}"`);
      console.log("  (Attempting to open browser automatically...)");
    } catch {
      console.log("  (Could not open browser automatically — please open the URL manually)");
    }
    console.log("");
    console.log(`  Waiting for callback on http://127.0.0.1:${CALLBACK_PORT}...`);
    console.log(`  (Timeout: ${TIMEOUT_MS / 1000}s — press Ctrl+C to cancel)`);
    console.log("");

    try {
      const t = await token;
      await finishLogin(t, options);
    } catch (err) {
      console.error(`Login failed: ${String((err as Error).message ?? err)}`);
      process.exit(1);
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface LoginOptions {
  paste: boolean;
  print: boolean;
  hideToken: boolean;
  status: boolean;
  replace: boolean;
  profile: AccountProfileId;
  /** True only when --profile was given. A profile login never displays the token. */
  profileRequested: boolean;
}

export type LoginArgumentResult = { ok: true; options: LoginOptions } | { ok: false; message: string };

/**
 * Parses login CLI arguments with no side effects. Unknown arguments are ignored,
 * as before. The invalid-value message lists the valid ids and does not echo the value.
 */
export function parseLoginArguments(argv: readonly string[]): LoginArgumentResult {
  const validIds = ACCOUNT_PROFILE_IDS.join(", ");
  let profile: AccountProfileId = "personal";
  let profileRequested = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg !== "--profile" && !arg.startsWith("--profile=")) continue;
    if (profileRequested) return { ok: false, message: "--profile may be given only once." };
    profileRequested = true;
    const value: string | undefined = arg === "--profile" ? argv[++index] : arg.slice("--profile=".length);
    if (value === undefined) return { ok: false, message: `Missing value for --profile. Valid profiles: ${validIds}.` };
    if (!isAccountProfileId(value)) return { ok: false, message: `Invalid --profile value. Valid profiles: ${validIds}.` };
    profile = value;
  }
  if (profileRequested && argv.includes("--print")) {
    return { ok: false, message: "--print cannot be combined with --profile; profile tokens are never printed." };
  }
  return {
    ok: true,
    options: {
      paste: argv.includes("--paste"),
      print: argv.includes("--print"),
      hideToken: argv.includes("--no-display-token") || profileRequested,
      status: argv.includes("--status"),
      replace: argv.includes("--replace"),
      profile,
      profileRequested,
    },
  };
}

/** Lines printed after a successful login. Pass `profile` only for an explicit --profile login. */
export function getLoginCompletionLines(
  token: string,
  printOnly: boolean,
  hideToken: boolean,
  profile?: AccountProfileId,
): string[] {
  if (printOnly) return profile === undefined && !hideToken ? [token] : [];

  const lines = ["  ✅ Login successful!", ""];
  if (profile === undefined) {
    lines.push(`  Token saved to: ${profileTokenPath(CONFIG_DIR, "personal")}`, "");
    if (!hideToken) lines.push("  Token (copy to your client's API key field):", `  ${token}`, "");
  } else {
    lines.push(`  Profile: ${profile}`, `  Token saved to: ${profileTokenPath(CONFIG_DIR, profile)}`, "");
  }
  lines.push("  Start the gateway and point your client at it:", "    bun run src/index.ts", "");
  return lines;
}

async function finishLogin(token: string, options: LoginOptions): Promise<void> {
  if (!options.print) {
    try {
      await writeProfileCredential(CONFIG_DIR, options.profile, token, { replace: options.replace });
    } catch (error) {
      if ((error as Error).message === "profile_already_enrolled") throw new Error(alreadySignedInMessage(options.profile));
      throw error;
    }
  }
  const profile = options.profileRequested ? options.profile : undefined;
  for (const line of getLoginCompletionLines(token, options.print, options.hideToken, profile)) console.log(line);
}

async function printProfileStatus(profile: AccountProfileId): Promise<void> {
  const lines = profileStatusLines({
    profile,
    name: await profileDisplayName(profile),
    state: await profileCredentialState(CONFIG_DIR, profile),
    tokenFile: profileTokenPath(CONFIG_DIR, profile),
  });
  for (const line of lines) console.log(line);
}

/** Status lines name the profile, its credential state, and its token file. They never include token text. */
export function profileStatusLines(status: {
  profile: AccountProfileId;
  name: string;
  state: CredentialState;
  tokenFile: string;
}): string[] {
  return [
    `Profile:    ${status.name} (${status.profile})`,
    `Credential: ${status.state}`,
    `Token file: ${status.tokenFile}`,
  ];
}

/** The name from accounts.json when it can be read, otherwise the default name. Read-only. */
async function profileDisplayName(profile: AccountProfileId): Promise<string> {
  try {
    const selection = await new AccountStore(defaultSettingsDirectory(), CONFIG_DIR).read();
    return selection.profiles.find((entry) => entry.id === profile)?.name ?? defaultProfileName(profile);
  } catch {
    return defaultProfileName(profile);
  }
}

function alreadySignedInMessage(profile: AccountProfileId): string {
  const command =
    profile === "personal" ? "devin-gateway login --replace" : `devin-gateway login --profile ${profile} --replace`;
  return `Profile "${profile}" already has a saved sign-in, which was left unchanged. Re-run with --replace to overwrite it: ${command}`;
}

/** Returns the refusal message when a save would overwrite a configured profile without --replace. */
export async function existingSignInRefusal(
  configDirectory: string,
  profile: AccountProfileId,
  options: { replace: boolean },
): Promise<string | undefined> {
  if (options.replace) return undefined;
  return (await profileCredentialState(configDirectory, profile)) === "configured"
    ? alreadySignedInMessage(profile)
    : undefined;
}

function startCallbackServer(session: {
  state: string;
  verifier: string;
}): { ready: Promise<void>; token: Promise<string> } {
  let resolveToken!: (v: string) => void;
  let rejectToken!: (e: unknown) => void;
  const token = new Promise<string>((res, rej) => {
    resolveToken = res;
    rejectToken = rej;
  });

  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let settled = false;
  let server: Server;

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      server.close();
      rejectToken(new Error("Login timed out"));
    }
  }, TIMEOUT_MS);

  const fail = (err: unknown): void => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      server.close();
      rejectToken(err);
    }
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "", `http://127.0.0.1:${CALLBACK_PORT}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    const sendHtml = (message: string): void => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(htmlBody(message));
    };

    if (error) {
      const desc = normalizedErrorMessage(url.searchParams.get("error_description") ?? error);
      fail(new Error(`Authorization failed: ${desc}`));
      sendHtml(`❌ Login failed: ${desc}`);
      return;
    }

    if (!code || state !== session.state) {
      fail(new Error("Invalid callback: missing code or state mismatch"));
      sendHtml("❌ Invalid callback");
      return;
    }

    // Exchange token
    exchangeToken(code, session.verifier)
      .then((t) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          server.close();
          resolveToken(t);
        }
      })
      .catch(fail);

    sendHtml("✅ Login successful! You can close this tab.");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      rejectReady(
        new Error(
          `Port ${CALLBACK_PORT} is already in use (another login in progress?). Free it and retry.`,
        ),
      );
    } else {
      rejectReady(err);
    }
    fail(err);
  });

  server.once("listening", () => resolveReady());
  server.listen(CALLBACK_PORT, "127.0.0.1");

  return { ready, token };
}

function htmlBody(message: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb"><div style="text-align:center;padding:2em;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,0.1)"><h1 style="font-size:1.5em;margin-bottom:0.5em">${message}</h1><p style="color:#666">You can close this tab.</p></div></body></html>`;
}

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question("", resolve));
    return answer.trim();
  } finally {
    rl.close();
  }
}

function execAsync(cmd: string): void {
  exec(cmd, () => {});
}

// ─── Direct-run guard (Bun: import.meta.main; Node: no-op via bin) ───────────
if (import.meta.main) {
  await runLogin(process.argv.slice(2));
}
