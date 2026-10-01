/**
 * Shared config: token file path + read/write helpers.
 *
 * The token file lives at `$DEVIN_GATEWAY_CONFIG_DIR/token` (default
 * `~/.devin-gateway/token`). The CLI login bin writes here. The gateway can
 * load this saved credential as its in-memory fallback at startup; request
 * credentials still take precedence.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.DEVIN_GATEWAY_CONFIG_DIR ?? join(homedir(), ".devin-gateway");
export const TOKEN_FILE = join(CONFIG_DIR, "token");

export async function readToken(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    return "";
  }
}

/** Use an explicitly configured fallback before the saved login token. */
export async function readFallbackToken(): Promise<string> {
  return process.env.DEVIN_API_KEY || await readToken();
}

export async function writeToken(token: string): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, token.trim(), "utf8");
}

export { CONFIG_DIR };
