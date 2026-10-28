/**
 * Per-install secret shared by the authenticated Nginx admin proxy and the
 * gateway's management listener.
 *
 * Nginx adds `X-Devin-Admin-Proxy` on the admin write path, after Basic auth
 * and the LAN allowlist. The browser cannot set the header, because Nginx
 * replaces any value a client sends. The gateway accepts management writes
 * only when the header matches this secret.
 *
 * The secret lives in a file in the settings volume (mode 0600). It is never
 * returned by any API, written to a log, or placed in the auth volume. Only the
 * file and an in-memory copy hold it, and callers receive a boolean.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const ADMIN_PROXY_SECRET_FILE = "admin-proxy-secret";
export const ADMIN_PROXY_HEADER = "x-devin-admin-proxy";
const SECRET_BYTES = 32;
/** Hex of 32 random bytes. Anything that is not exactly this length is refused. */
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

async function refuseSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("admin proxy secret path is a symbolic link");
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/** Reads the stored secret. Returns undefined when the file is absent or malformed. Never throws on content. */
async function readStoredSecret(file: string): Promise<string | undefined> {
  await refuseSymlink(file);
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  let handle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256) return undefined;
    const value = (await handle.readFile("utf8")).trim();
    return SECRET_PATTERN.test(value) ? value : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Loads the secret from the settings directory, or creates one when no valid
 * file exists. A malformed existing file is refused, not overwritten, so an
 * operator sees the problem instead of silently rotating the secret.
 */
export class AdminProxySecret {
  private value: string | undefined;
  private readonly file: string;

  constructor(settingsDirectory: string) {
    this.file = join(settingsDirectory, ADMIN_PROXY_SECRET_FILE);
  }

  async initialize(): Promise<void> {
    const stored = await readStoredSecret(this.file);
    if (stored !== undefined) {
      this.value = stored;
      return;
    }
    if (await this.exists()) throw new Error("admin proxy secret file is malformed; it was not replaced");
    this.value = await this.create();
  }

  /** Constant-time check. The header value is compared, never returned or logged. */
  matches(candidate: string | null): boolean {
    if (this.value === undefined || candidate === null) return false;
    const expected = Buffer.from(this.value, "utf8");
    const actual = Buffer.from(candidate, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async exists(): Promise<boolean> {
    try {
      await lstat(this.file);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async create(): Promise<string> {
    const secret = randomBytes(SECRET_BYTES).toString("hex");
    const temporary = join(dirname(this.file), `.admin-proxy-secret-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(secret + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== "win32") await chmod(temporary, 0o600);
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (!missing(error)) throw error;
      });
    }
    return secret;
  }
}