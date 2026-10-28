import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existingSignInRefusal,
  getLoginCompletionLines,
  parseLoginArguments,
  profileStatusLines,
} from "../src/cli/login.js";
import { CONFIG_DIR } from "../src/config.js";
import { writeProfileCredential } from "../src/accounts/profiles.js";

describe("login argument parsing", () => {
  test("no arguments targets the personal legacy profile without hiding or replacing", () => {
    expect(parseLoginArguments([])).toEqual({
      ok: true,
      options: {
        paste: false,
        print: false,
        hideToken: false,
        status: false,
        replace: false,
        profile: "personal",
        profileRequested: false,
      },
    });
  });

  test("accepts --profile in both forms and selects the team profile with the token hidden", () => {
    for (const argv of [["--profile", "team"], ["--profile=team"]]) {
      const result = parseLoginArguments(argv);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.options.profile).toBe("team");
        expect(result.options.profileRequested).toBe(true);
        expect(result.options.hideToken).toBe(true);
      }
    }
  });

  test("an invalid profile id is refused, the message lists valid ids, and the value is not echoed", () => {
    const result = parseLoginArguments(["--profile", "admin-owner"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("personal, team");
      expect(result.message).not.toContain("admin-owner");
    }
  });

  test("a missing, empty, or repeated --profile value is refused", () => {
    expect(parseLoginArguments(["--profile"]).ok).toBe(false);
    expect(parseLoginArguments(["--profile="]).ok).toBe(false);
    expect(parseLoginArguments(["--profile", "team", "--profile", "personal"]).ok).toBe(false);
  });

  test("--profile combined with --print is refused in both forms", () => {
    for (const argv of [["--profile", "team", "--print"], ["--print", "--profile=team"]]) {
      const result = parseLoginArguments(argv);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("--print");
    }
  });

  test("--print without --profile keeps the legacy print behavior", () => {
    const result = parseLoginArguments(["--print"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.print).toBe(true);
      expect(result.options.profileRequested).toBe(false);
    }
  });

  test("--replace, --paste, and --status are parsed alongside --profile", () => {
    const result = parseLoginArguments(["--replace", "--paste", "--status", "--profile", "team"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.replace).toBe(true);
      expect(result.options.paste).toBe(true);
      expect(result.options.status).toBe(true);
    }
  });
});

describe("profile login output", () => {
  test("a team completion names the profile and its token file without the token", () => {
    const token = "synthetic-team-login-token";
    const output = getLoginCompletionLines(token, false, true, "team").join("\n");
    expect(output).toContain("Profile: team");
    expect(output).toContain(join(CONFIG_DIR, "accounts", "team", "token"));
    expect(output).not.toContain(token);
  });

  test("a team completion does not print the token when --no-display-token is absent", () => {
    const token = "synthetic-team-login-token";
    const output = getLoginCompletionLines(token, false, false, "team").join("\n");
    expect(output).not.toContain(token);
  });

  test("status lines show name, state, and path only", () => {
    const tokenFile = join(CONFIG_DIR, "accounts", "team", "token");
    expect(
      profileStatusLines({ profile: "team", name: "Team", state: "configured", tokenFile }),
    ).toEqual(["Profile:    Team (team)", "Credential: configured", `Token file: ${tokenFile}`]);
  });
});

describe("existing sign-in guard", () => {
  let configDirectory: string;

  beforeEach(async () => {
    configDirectory = await mkdtemp(join(tmpdir(), "login-cli-guard-"));
  });

  afterEach(async () => {
    await rm(configDirectory, { recursive: true, force: true });
  });

  test("refuses an existing personal sign-in without --replace and names the replace command", async () => {
    await writeProfileCredential(configDirectory, "personal", "synthetic-guard-token", { replace: false });
    const message = await existingSignInRefusal(configDirectory, "personal", { replace: false });
    expect(message).toContain("--replace");
    expect(message).toContain('"personal"');
    expect(message).not.toContain("synthetic-guard-token");
  });

  test("names the profile in the replace command for team", async () => {
    await writeProfileCredential(configDirectory, "team", "synthetic-guard-token", { replace: false });
    const message = await existingSignInRefusal(configDirectory, "team", { replace: false });
    expect(message).toContain("--profile team --replace");
    expect(message).not.toContain("synthetic-guard-token");
  });

  test("allows a save with --replace or when the profile is unconfigured", async () => {
    await writeProfileCredential(configDirectory, "personal", "synthetic-guard-token", { replace: false });
    expect(await existingSignInRefusal(configDirectory, "personal", { replace: true })).toBeUndefined();
    expect(await existingSignInRefusal(configDirectory, "team", { replace: false })).toBeUndefined();
  });
});