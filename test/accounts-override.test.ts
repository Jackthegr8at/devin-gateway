/**
 * Static key override, run in its own process. The child gateway starts with
 * DEVIN_API_KEY in its environment. The parent asserts the child's results.
 * Synthetic keys only. No request leaves the process.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const STATIC = "synthetic-override-static-0403";

async function runChild(): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures", "accounts-override", "child.ts")], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, DEVIN_API_KEY: STATIC, SYNTHETIC_STATIC_KEY: STATIC, DEVIN_MODEL_SELECTION_ENABLED: "", HOST: "127.0.0.1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(child.stdout).text();
  await child.exited;
  const line = out.split("\n").find((entry) => entry.startsWith("RESULT "));
  if (!line) throw new Error("child produced no result line");
  return JSON.parse(line.slice("RESULT ".length));
}

describe("static key override (separate process)", () => {
  test("the selector cannot mislead while a static key is set", async () => {
    const result = await runChild();
    expect(result.staticOverride).toBe(true);
    expect(result.leaksStaticInView).toBe(false);
    expect(result.switchStatus).toBe(409);
    expect(result.switchCode).toBe("switching_disabled");
    expect(result.activeAfterRefusal).toBe("personal");
    expect(result.inferenceUsesStatic).toBe(true);
    expect(result.requestOverrideWins).toBe(true);
    expect(result.healthFallback).toBe(true);
    expect(result.healthLeaksStatic).toBe(false);
  }, 30_000);
});