import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountError, AccountStore, accountsETag, validateAccountUpdate } from "../src/accounts/account-store.js";
import {
  isAccountProfileId,
  profileCredentialState,
  profileTokenPath,
  readProfileCredential,
  writeProfileCredential,
} from "../src/accounts/profiles.js";

// Synthetic values only. Tests assert these never appear in errors.
const PERSONAL_TOKEN = "synthetic-personal-token";
const TEAM_TOKEN = "synthetic-team-token";
const STORE_FILE = "accounts.json";
const DEFAULT_STORE_TEXT =
  '{"schemaVersion":1,"revision":1,"activeProfileId":"personal","profiles":[{"id":"personal","name":"Personal"},{"id":"team","name":"Team"}]}\n';

const SYMLINK_SUPPORTED = (() => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-symlink-probe-"));
  try {
    symlinkSync(dir, join(dir, "probe-link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
let settingsDir: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "accounts-store-test-"));
  settingsDir = join(root, "settings");
  configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function storeAt(): AccountStore {
  return new AccountStore(settingsDir, configDir);
}

async function captureError(operation: () => unknown): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the operation to fail");
}

function captureSyncError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the operation to throw");
}

function expectAccountCode(error: unknown, code: AccountError["code"]): void {
  expect(error).toBeInstanceOf(AccountError);
  expect((error as AccountError).code).toBe(code);
}

function expectNoToken(error: unknown): void {
  const text = (error as Error).message;
  expect(text).not.toContain(PERSONAL_TOKEN);
  expect(text).not.toContain(TEAM_TOKEN);
}

function expectInvalidAccounts(value: unknown): void {
  try {
    validateAccountUpdate(value);
  } catch (error) {
    expectAccountCode(error, "invalid_accounts");
    return;
  }
  throw new Error("expected invalid_accounts");
}

async function storeText(): Promise<string> {
  return readFile(join(settingsDir, STORE_FILE), "utf8");
}

async function enrollPersonal(): Promise<void> {
  await writeProfileCredential(configDir, "personal", PERSONAL_TOKEN, { replace: false });
}

async function enrollTeam(): Promise<void> {
  await writeProfileCredential(configDir, "team", TEAM_TOKEN, { replace: false });
}

const renamedProfiles = (personal: string, team: string) => [
  { id: "personal", name: personal },
  { id: "team", name: team },
];

describe("profile token paths", () => {
  test("personal maps to the legacy token file and team maps to accounts/team/token", () => {
    expect(profileTokenPath(configDir, "personal")).toBe(join(configDir, "token"));
    expect(profileTokenPath(configDir, "team")).toBe(join(configDir, "accounts", "team", "token"));
  });

  test("only the two fixed ids are accepted", () => {
    expect(isAccountProfileId("personal")).toBe(true);
    expect(isAccountProfileId("team")).toBe(true);
    for (const value of ["Personal", "admin", "", " team", "__proto__", undefined, null, 1]) {
      expect(isAccountProfileId(value)).toBe(false);
    }
  });

  test("checking state does not create the team directories", async () => {
    expect(await profileCredentialState(configDir, "team")).toBe("unconfigured");
    expect(existsSync(join(configDir, "accounts"))).toBe(false);
  });
});

describe("credential state", () => {
  test("transitions from unconfigured to configured to invalid and back", async () => {
    const path = profileTokenPath(configDir, "personal");
    expect(await profileCredentialState(configDir, "personal")).toBe("unconfigured");

    await enrollPersonal();
    expect(await profileCredentialState(configDir, "personal")).toBe("configured");

    await writeFile(path, "synthetic personal token", "utf8");
    expect(await profileCredentialState(configDir, "personal")).toBe("invalid");

    await writeProfileCredential(configDir, "personal", PERSONAL_TOKEN, { replace: true });
    expect(await profileCredentialState(configDir, "personal")).toBe("configured");
  });

  test("whitespace-only content is unconfigured", async () => {
    await writeFile(profileTokenPath(configDir, "personal"), " \n\t ", "utf8");
    expect(await profileCredentialState(configDir, "personal")).toBe("unconfigured");
  });

  test("whitespace and control characters inside a token are invalid", async () => {
    const path = profileTokenPath(configDir, "team");
    await mkdir(join(configDir, "accounts", "team"), { recursive: true });
    for (const value of ["synthetic\tteam", "synthetic\u0007team", "synthetic\u007fteam", "synthetic\u0085team"]) {
      await writeFile(path, value, "utf8");
      expect(await profileCredentialState(configDir, "team")).toBe("invalid");
    }
  });

  test("the 8192 character limit is inclusive", async () => {
    const path = profileTokenPath(configDir, "personal");
    await writeFile(path, "a".repeat(8192), "utf8");
    expect(await profileCredentialState(configDir, "personal")).toBe("configured");
    await writeFile(path, "a".repeat(8193), "utf8");
    expect(await profileCredentialState(configDir, "personal")).toBe("invalid");
  });

  test("a token with surrounding whitespace is trimmed before classification", async () => {
    await writeFile(profileTokenPath(configDir, "personal"), `  ${PERSONAL_TOKEN}\n`, "utf8");
    expect(await profileCredentialState(configDir, "personal")).toBe("configured");
    expect(await readProfileCredential(configDir, "personal")).toBe(PERSONAL_TOKEN);
  });
});

describe("team enrollment isolation", () => {
  test("enrolling team leaves the personal token file byte-for-byte unchanged and refuses a second team write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "team-isolation-"));
    try {
      const personalFile = join(dir, "token");
      const personalBytes = Buffer.from("synthetic-personal-isolation-token\n", "utf8");
      await writeFile(personalFile, personalBytes, { mode: 0o600 });
      const before = await readFile(personalFile);
      await writeProfileCredential(dir, "team", "synthetic-team-isolation-token", { replace: false });
      expect((await readFile(personalFile)).equals(before)).toBe(true);
      expect((await readFile(join(dir, "accounts", "team", "token"), "utf8")).trim()).toBe("synthetic-team-isolation-token");
      await expect(writeProfileCredential(dir, "team", "synthetic-team-second", { replace: false })).rejects.toThrow("profile_already_enrolled");
      expect((await readFile(join(dir, "accounts", "team", "token"), "utf8")).trim()).toBe("synthetic-team-isolation-token");
      expect((await readFile(personalFile)).equals(before)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe("writeProfileCredential", () => {
  test("refuses an already configured profile without replace and leaves the file unchanged", async () => {
    await enrollPersonal();
    const error = await captureError(() =>
      writeProfileCredential(configDir, "personal", "synthetic-other-token", { replace: false }),
    );
    expect(error.message).toBe("profile_already_enrolled");
    expect(await readProfileCredential(configDir, "personal")).toBe(PERSONAL_TOKEN);
  });

  test("allows replacing a configured profile and leaves the other profile untouched", async () => {
    await enrollPersonal();
    await enrollTeam();
    await writeProfileCredential(configDir, "personal", "synthetic-personal-rotated", { replace: true });
    expect(await readProfileCredential(configDir, "personal")).toBe("synthetic-personal-rotated");
    expect(await readProfileCredential(configDir, "team")).toBe(TEAM_TOKEN);
  });

  test("replace also repairs an invalid file", async () => {
    await writeFile(profileTokenPath(configDir, "personal"), "bad value", "utf8");
    await writeProfileCredential(configDir, "personal", PERSONAL_TOKEN, { replace: false });
    expect(await readProfileCredential(configDir, "personal")).toBe(PERSONAL_TOKEN);
  });

  test("rejects an invalid token without echoing it", async () => {
    const error = await captureError(() =>
      writeProfileCredential(configDir, "personal", `${PERSONAL_TOKEN} with space`, { replace: false }),
    );
    expect(error).toBeInstanceOf(Error);
    expectNoToken(error);
    expect(existsSync(profileTokenPath(configDir, "personal"))).toBe(false);
  });

  test("writing the team profile creates its directory and leaves no temporary files", async () => {
    await enrollTeam();
    expect(await readProfileCredential(configDir, "team")).toBe(TEAM_TOKEN);
    const entries = await readdir(join(configDir, "accounts", "team"));
    expect(entries).toEqual(["token"]);
    expect(await readdir(configDir)).toContain("accounts");
  });

  test("writing the personal profile does not create the accounts directory", async () => {
    await enrollPersonal();
    expect(existsSync(join(configDir, "accounts"))).toBe(false);
    expect((await readdir(configDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("token file is written with mode 0600", async () => {
    await enrollPersonal();
    expect((await stat(profileTokenPath(configDir, "personal"))).mode & 0o777).toBe(0o600);
  });

  test.skipIf(!SYMLINK_SUPPORTED)("refuses to write through a symlinked token path", async () => {
    const outside = join(root, "outside-target");
    await symlink(outside, profileTokenPath(configDir, "personal"), "file");
    const error = await captureError(() =>
      writeProfileCredential(configDir, "personal", PERSONAL_TOKEN, { replace: true }),
    );
    expect(error.message).toContain("symbolic link");
    expectNoToken(error);
    expect(existsSync(outside)).toBe(false);
  });
});

describe("readProfileCredential", () => {
  test("returns empty strings for unconfigured and invalid profiles", async () => {
    expect(await readProfileCredential(configDir, "personal")).toBe("");
    await writeFile(profileTokenPath(configDir, "personal"), "two words", "utf8");
    expect(await readProfileCredential(configDir, "personal")).toBe("");
  });

  test("returns empty string and does not throw when the token path is unreadable", async () => {
    await mkdir(profileTokenPath(configDir, "personal"));
    expect(await profileCredentialState(configDir, "personal")).toBe("invalid");
    await expect(readProfileCredential(configDir, "personal")).resolves.toBe("");
  });

  test("never creates or rewrites the legacy token file on read", async () => {
    await enrollPersonal();
    const before = await readFile(profileTokenPath(configDir, "personal"), "utf8");
    await readProfileCredential(configDir, "personal");
    await profileCredentialState(configDir, "personal");
    expect(await readFile(profileTokenPath(configDir, "personal"), "utf8")).toBe(before);
    expect(existsSync(profileTokenPath(configDir, "team"))).toBe(false);
  });
});

describe("validateAccountUpdate", () => {
  test("accepts profiles in any order and returns them in fixed order with trimmed names", () => {
    const result = validateAccountUpdate({
      activeProfileId: "team",
      profiles: [
        { id: "team", name: "  Work  " },
        { id: "personal", name: "Home" },
      ],
    });
    expect(result).toEqual({
      activeProfileId: "team",
      profiles: [
        { id: "personal", name: "Home" },
        { id: "team", name: "Work" },
      ],
    });
  });

  test("accepts names of exactly 1 and 40 characters", () => {
    expect(() =>
      validateAccountUpdate({
        activeProfileId: "personal",
        profiles: renamedProfiles("P", "a".repeat(40)),
      }),
    ).not.toThrow();
  });

  test("rejects empty, over-long, and control-character names", () => {
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("   ", "Team") });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("Personal", "a".repeat(41)) });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("Per\u0000sonal", "Team") });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("Per\u001fsonal", "Team") });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("Per\u007fsonal", "Team") });
  });

  test("rejects names that collide case-insensitively", () => {
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("Work", " work ") });
  });

  test("rejects unknown, missing, duplicate, or extra profile entries", () => {
    expectInvalidAccounts({ activeProfileId: "personal", profiles: [{ id: "personal", name: "A" }, { id: "admin", name: "B" }] });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: [{ id: "personal", name: "A" }, { id: "personal", name: "B" }] });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: [{ id: "personal", name: "A" }] });
    expectInvalidAccounts({
      activeProfileId: "personal",
      profiles: [...renamedProfiles("A", "B"), { id: "team", name: "C" }],
    });
    expectInvalidAccounts({
      activeProfileId: "personal",
      profiles: [{ id: "personal", name: "A", token: "x" }, { id: "team", name: "B" }],
    });
  });

  test("rejects an unknown active id and extra top-level keys", () => {
    expectInvalidAccounts({ activeProfileId: "admin", profiles: renamedProfiles("A", "B") });
    expectInvalidAccounts({ profiles: renamedProfiles("A", "B") });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("A", "B"), revision: 5 });
    expectInvalidAccounts({ activeProfileId: "personal", profiles: renamedProfiles("A", "B"), schemaVersion: 1 });
    expectInvalidAccounts(null);
    expectInvalidAccounts(["personal"]);
  });

  test("ETag includes the revision and its quotes", () => {
    expect(accountsETag({ schemaVersion: 1, revision: 3, activeProfileId: "personal", profiles: [] })).toBe(
      '"accounts-v1-3"',
    );
  });
});

describe("AccountStore initialize", () => {
  test("writes the default selection when the file is missing", async () => {
    const selection = await storeAt().initialize();
    expect(selection).toEqual({
      schemaVersion: 1,
      revision: 1,
      activeProfileId: "personal",
      profiles: [
        { id: "personal", name: "Personal" },
        { id: "team", name: "Team" },
      ],
    });
    expect(await storeText()).toBe(DEFAULT_STORE_TEXT);
  });

  test("returns an existing valid selection without rewriting it", async () => {
    const store = storeAt();
    await store.initialize();
    const first = await storeText();
    const again = await new AccountStore(settingsDir, configDir).initialize();
    expect(again.revision).toBe(1);
    expect(await storeText()).toBe(first);
  });

  test("does not copy or create token files", async () => {
    await enrollPersonal();
    await storeAt().initialize();
    expect(existsSync(join(configDir, "accounts"))).toBe(false);
    expect(await readProfileCredential(configDir, "personal")).toBe(PERSONAL_TOKEN);
  });

  test("read refuses a missing file and does not create one", async () => {
    const error = await captureError(() => storeAt().read());
    expectAccountCode(error, "accounts_unavailable");
    expect(existsSync(join(settingsDir, STORE_FILE))).toBe(false);
  });
});

describe("AccountStore update", () => {
  test("activates a configured profile and increments the revision", async () => {
    await enrollPersonal();
    await enrollTeam();
    const store = storeAt();
    const initial = await store.initialize();
    expect(store.activeProfileId()).toBe("personal");

    const next = await store.update(
      { activeProfileId: "team", profiles: renamedProfiles("Personal", "Work") },
      accountsETag(initial),
    );

    expect(next.revision).toBe(2);
    expect(next.activeProfileId).toBe("team");
    expect(next.profiles).toEqual([
      { id: "personal", name: "Personal" },
      { id: "team", name: "Work" },
    ]);
    expect(store.activeProfileId()).toBe("team");
    expect(JSON.parse(await storeText())).toEqual({ ...next });
  });

  test("a stale ETag gives revision_conflict and changes nothing", async () => {
    await enrollPersonal();
    await enrollTeam();
    const store = storeAt();
    const initial = await store.initialize();
    await store.update({ activeProfileId: "personal", profiles: renamedProfiles("A", "B") }, accountsETag(initial));

    const before = await storeText();
    const error = await captureError(() =>
      store.update({ activeProfileId: "team", profiles: renamedProfiles("A", "B") }, accountsETag(initial)),
    );
    expectAccountCode(error, "revision_conflict");
    expect(await storeText()).toBe(before);
    expect(store.activeProfileId()).toBe("personal");
  });

  test("activating an unconfigured profile gives account_unconfigured and keeps the active id", async () => {
    await enrollPersonal();
    const store = storeAt();
    const initial = await store.initialize();
    const error = await captureError(() =>
      store.update({ activeProfileId: "team", profiles: renamedProfiles("Personal", "Team") }, accountsETag(initial)),
    );
    expectAccountCode(error, "account_unconfigured");
    expect(store.activeProfileId()).toBe("personal");
    expect(await storeText()).toBe(DEFAULT_STORE_TEXT);
  });

  test("activating an invalid profile is also account_unconfigured", async () => {
    await enrollPersonal();
    await mkdir(join(configDir, "accounts", "team"), { recursive: true });
    await writeFile(profileTokenPath(configDir, "team"), "two words", "utf8");
    const store = storeAt();
    const initial = await store.initialize();
    const error = await captureError(() =>
      store.update({ activeProfileId: "team", profiles: renamedProfiles("Personal", "Team") }, accountsETag(initial)),
    );
    expectAccountCode(error, "account_unconfigured");
  });

  test("renaming while the active profile is unconfigured succeeds, but switching to an unconfigured profile is rejected", async () => {
    await enrollPersonal();
    await enrollTeam();
    const store = storeAt();
    const initial = await store.initialize();
    const onTeam = await store.update({ activeProfileId: "team", profiles: renamedProfiles("Personal", "Team") }, accountsETag(initial));

    // The active team token is removed after activation; the active id stays team.
    await unlink(profileTokenPath(configDir, "team"));
    expect(await profileCredentialState(configDir, "team")).toBe("unconfigured");

    const renamed = await store.update(
      { activeProfileId: "team", profiles: renamedProfiles("Home", "Work") },
      accountsETag(onTeam),
    );
    expect(renamed.revision).toBe(3);
    expect(renamed.activeProfileId).toBe("team");
    expect(renamed.profiles).toEqual([
      { id: "personal", name: "Home" },
      { id: "team", name: "Work" },
    ]);

    // Moving the active id from team (unconfigured) to personal is allowed because personal is configured.
    const back = await store.update({ activeProfileId: "personal", profiles: renamedProfiles("Home", "Work") }, accountsETag(renamed));
    expect(back.activeProfileId).toBe("personal");

    // Moving the active id to the unconfigured team profile is rejected.
    const error = await captureError(() =>
      store.update({ activeProfileId: "team", profiles: renamedProfiles("Home", "Work") }, accountsETag(back)),
    );
    expectAccountCode(error, "account_unconfigured");
    expect(store.activeProfileId()).toBe("personal");
  });

  test("invalid input is refused before the ETag check and changes nothing", async () => {
    const store = storeAt();
    const initial = await store.initialize();
    const error = await captureError(() =>
      store.update({ activeProfileId: "personal", profiles: renamedProfiles("Same", "same") }, accountsETag(initial)),
    );
    expectAccountCode(error, "invalid_accounts");
    expect(await storeText()).toBe(DEFAULT_STORE_TEXT);
  });

  test("concurrent updates with the same ETag let exactly one win", async () => {
    await enrollPersonal();
    await enrollTeam();
    const store = storeAt();
    const initial = await store.initialize();
    const etag = accountsETag(initial);
    const results = await Promise.allSettled([
      store.update({ activeProfileId: "team", profiles: renamedProfiles("A", "B") }, etag),
      store.update({ activeProfileId: "personal", profiles: renamedProfiles("C", "D") }, etag),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expectAccountCode(rejected[0]?.reason, "revision_conflict");
  });

  test("persists across a new store instance", async () => {
    await enrollPersonal();
    await enrollTeam();
    const first = storeAt();
    const initial = await first.initialize();
    const next = await first.update({ activeProfileId: "team", profiles: renamedProfiles("Personal", "Work") }, accountsETag(initial));

    const reopened = new AccountStore(settingsDir, configDir);
    const loaded = await reopened.initialize();
    expect(loaded).toEqual(next);
    expect(reopened.activeProfileId()).toBe("team");
    expect(await reopened.read()).toEqual(next);
  });
});

describe("corrupt or unexpected store files", () => {
  const corruptCases: Array<[string, string]> = [
    ["not JSON", "{ not json"],
    ["unknown extra key", '{"schemaVersion":1,"revision":1,"activeProfileId":"personal","profiles":[{"id":"personal","name":"Personal"},{"id":"team","name":"Team"}],"extra":true}'],
    ["schema version 2", '{"schemaVersion":2,"revision":1,"activeProfileId":"personal","profiles":[{"id":"personal","name":"Personal"},{"id":"team","name":"Team"}]}'],
    ["reversed profile order", '{"schemaVersion":1,"revision":1,"activeProfileId":"personal","profiles":[{"id":"team","name":"Team"},{"id":"personal","name":"Personal"}]}'],
    ["zero revision", '{"schemaVersion":1,"revision":0,"activeProfileId":"personal","profiles":[{"id":"personal","name":"Personal"},{"id":"team","name":"Team"}]}'],
    ["unknown active id", '{"schemaVersion":1,"revision":1,"activeProfileId":"admin","profiles":[{"id":"personal","name":"Personal"},{"id":"team","name":"Team"}]}'],
  ];

  for (const [label, text] of corruptCases) {
    test(`${label} is refused, reported as accounts_unavailable, and not reset`, async () => {
      await mkdir(settingsDir, { recursive: true });
      await writeFile(join(settingsDir, STORE_FILE), text, "utf8");
      const store = storeAt();

      expectAccountCode(await captureError(() => store.initialize()), "accounts_unavailable");
      expectAccountCode(await captureError(() => store.read()), "accounts_unavailable");
      expectAccountCode(
        await captureError(() => store.update({ activeProfileId: "personal", profiles: renamedProfiles("A", "B") }, '"accounts-v1-1"')),
        "accounts_unavailable",
      );
      expect(await storeText()).toBe(text);
    });
  }
});

describe("settings and config directory overlap", () => {
  test("refuses identical, nested, and enclosing directories", () => {
    expectAccountCode(captureSyncError(() => new AccountStore(configDir, configDir)), "accounts_unavailable");
    expectAccountCode(captureSyncError(() => new AccountStore(join(configDir, "settings"), configDir)), "accounts_unavailable");
    expectAccountCode(captureSyncError(() => new AccountStore(settingsDir, join(settingsDir, "config"))), "accounts_unavailable");
  });

  test("accepts sibling directories", () => {
    expect(() => new AccountStore(settingsDir, configDir)).not.toThrow();
  });
});

describe("store path symlinks", () => {
  test.skipIf(!SYMLINK_SUPPORTED)("refuses an accounts.json that is a symlink and leaves its target alone", async () => {
    await mkdir(settingsDir, { recursive: true });
    const target = join(root, "elsewhere.json");
    await writeFile(target, DEFAULT_STORE_TEXT, "utf8");
    await symlink(target, join(settingsDir, STORE_FILE), "file");

    expectAccountCode(await captureError(() => storeAt().initialize()), "accounts_unavailable");
    expect(await readFile(target, "utf8")).toBe(DEFAULT_STORE_TEXT);
  });
});

describe("secret handling", () => {
  test("no refusal or failure message contains the synthetic token", async () => {
    await enrollPersonal();
    const errors: unknown[] = [];
    errors.push(await captureError(() => writeProfileCredential(configDir, "personal", "synthetic-new-token", { replace: false })));
    errors.push(await captureError(() => writeProfileCredential(configDir, "personal", `${PERSONAL_TOKEN} spaced`, { replace: true })));

    const store = storeAt();
    const initial = await store.initialize();
    errors.push(await captureError(() => store.update({ activeProfileId: "team", profiles: renamedProfiles("A", "B") }, accountsETag(initial))));
    errors.push(await captureError(() => store.update({ activeProfileId: "personal", profiles: renamedProfiles("A", "B") }, '"accounts-v1-9"')));

    for (const error of errors) expectNoToken(error);
    expect(await readProfileCredential(configDir, "personal")).toBe(PERSONAL_TOKEN);
  });
});