/**
 * Account profiles: two fixed sign-in slots, `personal` and `team`.
 *
 * Each profile keeps its Devin token in its own file. The personal profile
 * uses the legacy `<config>/token` file, so an existing sign-in keeps working
 * without a copy. The team profile uses `<config>/accounts/team/token`.
 *
 * Token values are never logged and never included in error messages.
 */
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const ACCOUNT_PROFILE_IDS = ["personal", "team"] as const;
export type AccountProfileId = (typeof ACCOUNT_PROFILE_IDS)[number];
export type CredentialState = "configured" | "unconfigured" | "invalid";

const MAX_TOKEN_CHARACTERS = 8192;
// Whitespace and C0/C1 control characters are not allowed inside a token.
const UNSAFE_TOKEN_CHARACTER = /[\s\u0000-\u001f\u007f-\u009f]/;

export function isAccountProfileId(value: unknown): value is AccountProfileId {
  return typeof value === "string" && (ACCOUNT_PROFILE_IDS as readonly string[]).includes(value);
}

export function profileTokenPath(configDirectory: string, id: AccountProfileId): string {
  if (!isAccountProfileId(id)) throw new Error("Unknown account profile.");
  return id === "personal"
    ? join(configDirectory, "token")
    : join(configDirectory, "accounts", "team", "token");
}

interface ClassifiedToken {
  state: CredentialState;
  token: string;
}

/** Applies the token rules to raw file contents. The token is returned only when configured. */
function classify(raw: string): ClassifiedToken {
  const token = raw.trim();
  if (token === "") return { state: "unconfigured", token: "" };
  if (token.length > MAX_TOKEN_CHARACTERS || UNSAFE_TOKEN_CHARACTER.test(token)) {
    return { state: "invalid", token: "" };
  }
  return { state: "configured", token };
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const storageUnavailable = (): Error =>
  new Error("Credential storage is unavailable or contains a symbolic link; nothing was written.");
const invalidCredential = (): Error => new Error("Credential is empty or malformed; nothing was written.");

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Refuses to write through a symlink at the token file or at the team account directories it would create. */
async function refuseSymbolicLinks(path: string, id: AccountProfileId): Promise<void> {
  const chain = id === "personal" ? [path] : [path, dirname(path), dirname(dirname(path))];
  for (const candidate of chain) {
    if (await isSymbolicLink(candidate)) throw storageUnavailable();
  }
}

export async function profileCredentialState(
  configDirectory: string,
  id: AccountProfileId,
): Promise<CredentialState> {
  const path = profileTokenPath(configDirectory, id);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return missing(error) ? "unconfigured" : "invalid";
  }
  return classify(raw).state;
}

/** Returns the trimmed token only when the profile is configured. Never throws. Returns "" otherwise. */
export async function readProfileCredential(configDirectory: string, id: AccountProfileId): Promise<string> {
  try {
    const { state, token } = classify(await readFile(profileTokenPath(configDirectory, id), "utf8"));
    return state === "configured" ? token : "";
  } catch {
    return "";
  }
}

export async function writeProfileCredential(
  configDirectory: string,
  id: AccountProfileId,
  token: string,
  options: { replace: boolean },
): Promise<void> {
  const path = profileTokenPath(configDirectory, id);
  const candidate = classify(typeof token === "string" ? token : "");
  if (candidate.state !== "configured") throw invalidCredential();
  if (!options.replace && (await profileCredentialState(configDirectory, id)) === "configured") {
    throw new Error("profile_already_enrolled");
  }
  await refuseSymbolicLinks(path, id);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const temporary = join(directory, `.token-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(candidate.token, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (!missing(error)) throw error;
    });
  }
}