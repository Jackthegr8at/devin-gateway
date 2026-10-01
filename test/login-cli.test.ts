import { describe, expect, test } from "bun:test";
import { getLoginCompletionLines } from "../src/cli/login.js";

describe("login token display", () => {
  test("Docker-style login reports success without including the token", () => {
    const token = "synthetic-login-token-do-not-print";
    const output = getLoginCompletionLines(token, false, true).join("\n");
    expect(output).toContain("Login successful");
    expect(output).toContain("Token saved to:");
    expect(output).not.toContain(token);
  });

  test("legacy print-only login remains explicit and unchanged", () => {
    const token = "synthetic-login-token";
    expect(getLoginCompletionLines(token, true, false)).toEqual([token]);
  });

  test("print-only output can also be suppressed", () => {
    expect(getLoginCompletionLines("synthetic-login-token", true, true)).toEqual([]);
  });
});
