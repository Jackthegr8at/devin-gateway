import { expect, test } from "bun:test";
import { SWE_AUTONOMY_SUPPLEMENT, withSweAutonomySupplement } from "../src/responses-swe-autonomy.ts";
import { collapseSystemPromptIntoLatestUserMessage } from "../src/responses-system-collapse.ts";
import { ChatMessageSource } from "../src/proto.ts";

const syntheticAnchor = "Synthetic runtime anchor\n  Preserve whitespace.\n";
test("SWE guidance combines autonomous continuation with sequential tool execution", () => {
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("Continue until the task is complete or genuinely blocked");
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("execute it rather than ending with an announcement");
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("Issue at most one tool call at a time.");
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("After its result is returned, continue with the next necessary action in the following turn.");
});
test("only reviewed resolved SWE variants receive separate guidance", () => {
  for (const model of ["swe-2-medium", "swe-2-high", "swe-2-max"]) {
    const result = withSweAutonomySupplement(syntheticAnchor, model);
    expect(result.slice(0, syntheticAnchor.length)).toBe(syntheticAnchor);
    expect(result).toBe(`${syntheticAnchor}\n\n[Gateway SWE autonomy supplement]\n${SWE_AUTONOMY_SUPPLEMENT}`);
  }
  for (const model of ["glm-5-3-flash-low", "swe-2", "swe-2-future", "SWE-2-high", "other"]) {
    expect(withSweAutonomySupplement(syntheticAnchor, model)).toBe(syntheticAnchor);
  }
});
test("normal completion and genuine safety stops remain explicitly permitted", () => {
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("Finish normally when the task is complete");
  for (const boundary of ["user input", "authorization", "approval", "destructive action", "genuinely blocked"]) expect(SWE_AUTONOMY_SUPPLEMENT).toContain(boundary);
});
test("collapse preserves composed bytes and does not mutate history", () => {
  const effective = withSweAutonomySupplement(syntheticAnchor, "swe-2-high");
  const prompts = [{ messageId: "synthetic", source: ChatMessageSource.USER, prompt: "Synthetic task" }];
  const before = structuredClone(prompts);
  const result = collapseSystemPromptIntoLatestUserMessage(effective, prompts);
  expect(result.systemPrompt).toBe("");
  expect(result.collapsedUserPayload).toBe(`<system>\n${effective}\n</system>\n\nSynthetic task`);
  expect(prompts).toEqual(before);
});
