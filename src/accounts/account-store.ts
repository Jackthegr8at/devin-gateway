/**
 * Account selection store: which account profile is active, plus the display
 * names of the two fixed profiles.
 *
 * The store file is `<settingsDirectory>/accounts.json`. It never holds a
 * token; token files are managed by ./profiles.ts. A corrupt or unknown-shape
 * file is refused and never replaced with defaults.
 */
import { chmod, lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ACCOUNT_PROFILE_IDS,
  isAccountProfileId,
  profileCredentialState,
  type AccountProfileId,
} from "./profiles.js";

export interface AccountProfile {
  id: AccountProfileId;
  name: string;
}

export interface AccountSelection {
  schemaVersion: 1;
  revision: number;
  activeProfileId: AccountProfileId;
  profiles: AccountProfile[];
}

export class AccountError extends Error {
  constructor(
    readonly code: "invalid_accounts" | "account_unconfigured" | "revision_conflict" | "accounts_unavailable",
    message: string,
  ) {
    super(message);
  }
}

const STORE_FILE = "accounts.json";
const MAX_STORE_BYTES = 16 * 1024;
const NAME_MAX_CHARACTERS = 40;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const STORE_KEYS = ["activeProfileId", "profiles", "revision", "schemaVersion"];
const DEFAULT_NAMES: Readonly<Record<AccountProfileId, string>> = { personal: "Personal", team: "Team" };

export function defaultProfileName(id: AccountProfileId): string {
  return DEFAULT_NAMES[id];
}

export function accountsETag(selection: AccountSelection): string {
  return `"accounts-v1-${selection.revision}"`;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const unavailable = (): AccountError =>
  new AccountError("accounts_unavailable", "Account storage is unavailable or invalid; no defaults were substituted.");
function invalidAccounts(): never {
  throw new AccountError(
    "invalid_accounts",
    "Invalid account update. Send activeProfileId and profiles for personal and team only; names must be unique, 1 to 40 characters, and free of control characters.",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validName(value: unknown): string {
  if (typeof value !== "string") invalidAccounts();
  const trimmed = (value as string).trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > NAME_MAX_CHARACTERS || CONTROL_CHARACTER.test(trimmed)) invalidAccounts();
  return trimmed;
}

/** Returns exactly one entry per profile in the fixed order, or refuses the input. */
function orderedProfiles(value: unknown): AccountProfile[] {
  if (!Array.isArray(value) || value.length !== ACCOUNT_PROFILE_IDS.length) invalidAccounts();
  const names = new Map<AccountProfileId, string>();
  const folded = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ["id", "name"])) invalidAccounts();
    const { id, name } = entry as { id: unknown; name: unknown };
    if (!isAccountProfileId(id) || names.has(id)) invalidAccounts();
    const cleaned = validName(name);
    const key = cleaned.toLowerCase();
    if (folded.has(key)) invalidAccounts();
    folded.add(key);
    names.set(id, cleaned);
  }
  return ACCOUNT_PROFILE_IDS.map((id) => {
    const name = names.get(id);
    if (name === undefined) invalidAccounts();
    return { id, name: name as string };
  });
}

/** Validates an update request. Only activeProfileId and profiles are accepted; output is in fixed profile order. */
export function validateAccountUpdate(value: unknown): { activeProfileId: AccountProfileId; profiles: AccountProfile[] } {
  if (!isPlainObject(value) || !hasExactKeys(value, ["activeProfileId", "profiles"])) invalidAccounts();
  const { activeProfileId, profiles } = value as { activeProfileId: unknown; profiles: unknown };
  if (!isAccountProfileId(activeProfileId)) invalidAccounts();
  return { activeProfileId, profiles: orderedProfiles(profiles) };
}

function initialSelection(): AccountSelection {
  return {
    schemaVersion: 1,
    revision: 1,
    activeProfileId: "personal",
    profiles: ACCOUNT_PROFILE_IDS.map((id) => ({ id, name: defaultProfileName(id) })),
  };
}

/** Strict parse of the stored file. Any deviation is unavailable, never a reset. */
function parseStored(value: unknown): AccountSelection {
  try {
    if (!isPlainObject(value) || !hasExactKeys(value, STORE_KEYS)) throw unavailable();
    const { schemaVersion, revision, activeProfileId, profiles } = value as Record<string, unknown>;
    if (schemaVersion !== 1) throw unavailable();
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw unavailable();
    if (!isAccountProfileId(activeProfileId)) throw unavailable();
    const ordered = orderedProfiles(profiles);
    const stored = profiles as AccountProfile[];
    if (stored.some((profile, index) => profile.id !== ordered[index]?.id)) throw unavailable();
    return { schemaVersion: 1, revision, activeProfileId, profiles: ordered };
  } catch {
    throw unavailable();
  }
}

/** Rejects symlinks anywhere on the path, the way ModelSelectionStore does. */
async function noSymlinks(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw unavailable();
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Serializes operations and writes atomically. Locking is within one process only. */
export class AccountStore {
  readonly directory: string;
  private readonly file: string;
  private readonly configDirectory: string;
  private active: AccountProfileId | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(settingsDirectory: string, configDirectory: string) {
    this.directory = resolve(settingsDirectory);
    this.configDirectory = resolve(configDirectory);
    this.file = join(this.directory, STORE_FILE);
    const overlaps = (parent: string, child: string): boolean => {
      const part = relative(resolve(parent), resolve(child));
      return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
    };
    if (overlaps(this.configDirectory, this.directory) || overlaps(this.directory, this.configDirectory)) throw unavailable();
  }

  /** Loads the store, or writes defaults when the file is missing. A corrupt file is refused. */
  initialize(): Promise<AccountSelection> {
    return this.serialize(async () => {
      try {
        await noSymlinks(this.directory);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(this.directory, 0o700);
        const stored = await this.loadStored();
        const selection = stored ?? initialSelection();
        if (stored === null) await this.replace(selection);
        this.active = selection.activeProfileId;
        return selection;
      } catch {
        throw unavailable();
      }
    });
  }

  read(): Promise<AccountSelection> {
    return this.serialize(async () => {
      const selection = await this.current();
      this.active = selection.activeProfileId;
      return selection;
    });
  }

  /** Returns the active profile loaded by the last initialize, read, or update. */
  activeProfileId(): AccountProfileId {
    if (this.active === undefined) throw unavailable();
    return this.active;
  }

  async update(value: unknown, expectedETag: string): Promise<AccountSelection> {
    const proposed = validateAccountUpdate(value);
    return this.serialize(async () => {
      const current = await this.current();
      if (expectedETag !== accountsETag(current)) {
        throw new AccountError("revision_conflict", "Account selection changed; fetch the current revision before saving.");
      }
      if (proposed.activeProfileId !== current.activeProfileId) {
        const state = await profileCredentialState(this.configDirectory, proposed.activeProfileId);
        if (state !== "configured") {
          throw new AccountError(
            "account_unconfigured",
            `Profile "${proposed.activeProfileId}" has no usable sign-in; sign in to it before making it active.`,
          );
        }
      }
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw unavailable();
      const next: AccountSelection = {
        schemaVersion: 1,
        revision: current.revision + 1,
        activeProfileId: proposed.activeProfileId,
        profiles: proposed.profiles,
      };
      try {
        await this.replace(next);
      } catch {
        throw unavailable();
      }
      this.active = next.activeProfileId;
      return next;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async current(): Promise<AccountSelection> {
    try {
      const stored = await this.loadStored();
      if (stored === null) throw unavailable();
      return stored;
    } catch {
      throw unavailable();
    }
  }

  /** Returns null when the file is missing. Any other problem with the file throws unavailable. */
  private async loadStored(): Promise<AccountSelection | null> {
    await noSymlinks(this.file);
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    let file: FileHandle;
    try {
      file = await open(this.file, flags);
    } catch (error) {
      if (missing(error)) return null;
      throw unavailable();
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw unavailable();
      let parsed: unknown;
      try {
        parsed = JSON.parse((await file.readFile()).toString("utf8"));
      } catch {
        throw unavailable();
      }
      return parseStored(parsed);
    } finally {
      await file.close();
    }
  }

  private async replace(selection: AccountSelection): Promise<void> {
    await noSymlinks(this.file);
    const body =
      JSON.stringify({
        schemaVersion: 1,
        revision: selection.revision,
        activeProfileId: selection.activeProfileId,
        profiles: selection.profiles.map((profile) => ({ id: profile.id, name: profile.name })),
      }) + "\n";
    const temporary = join(this.directory, `.accounts-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(body, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (!missing(error)) throw error;
      });
    }
  }
}