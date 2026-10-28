import { expect, test } from "bun:test";
import { SWE_AUTONOMY_SUPPLEMENT, withSweAutonomySupplement } from "../src/responses-swe-autonomy.ts";
import { collapseSystemPromptIntoLatestUserMessage } from "../src/responses-system-collapse.ts";
import { ChatMessageSource } from "../src/proto.ts";
import { StopReason } from "../src/proto.ts";
import { SWE_COMPLETION_INSTRUCTION, sweResponseEndTurn, withSweCompletionInstruction } from "../src/responses-swe-autonomy.ts";

const syntheticAnchor = "Synthetic runtime anchor\n  Preserve whitespace.\n";
test("opt-in completion guidance uses exact reviewed SWE identities on every continuation", () => {
  for (const model of ["swe-2-medium", "swe-2-high", "swe-2-max"]) {
    for (let turn = 0; turn < 20; turn++) {
      const effective = withSweCompletionInstruction(syntheticAnchor, model, true);
      expect(effective.startsWith(syntheticAnchor)).toBe(true);
      expect(effective).toContain(SWE_COMPLETION_INSTRUCTION);
    }
    expect(withSweCompletionInstruction(syntheticAnchor, model, false)).toBe(syntheticAnchor);
    expect(sweResponseEndTurn(model, false, "Synthetic", 2, 0)).toBeUndefined();
    expect(sweResponseEndTurn(model, true, "Synthetic", 2, 0)).toBe(false);
    expect(sweResponseEndTurn(model, true, "Done\r\n[PROCESS_DONE]\n\t", 2, 0)).toBe(true);
    expect(sweResponseEndTurn(model, true, "Done\n[PROCESS_DONE]", 1, 0)).toBe(true);
    for (const invalid of ["Done [PROCESS_DONE]", "[PROCESS_DONE]\nMore", "[process_done]", " [PROCESS_DONE]"]) {
      expect(sweResponseEndTurn(model, true, invalid, 2, 0)).toBe(false);
    }
    expect(sweResponseEndTurn(model, true, "Done", 1, 0)).toBeUndefined();
    expect(sweResponseEndTurn(model, true, "[PROCESS_DONE]", StopReason.MAX_TOKENS, 0)).toBeUndefined();
    expect(sweResponseEndTurn(model, true, "[PROCESS_DONE]", StopReason.FUNCTION_CALL, 1)).toBeUndefined();
  }
  for (const model of ["glm-5-3-flash-low", "swe-2", "swe-2-future", "SWE-2-high"]) {
    expect(withSweCompletionInstruction(syntheticAnchor, model, true)).toBe(syntheticAnchor);
    expect(sweResponseEndTurn(model, true, "Synthetic", 2, 0)).toBeUndefined();
  }
});
test("SWE guidance retains autonomy without duplicating the bridge capability", () => {
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("Continue until the task is complete or genuinely blocked");
  expect(SWE_AUTONOMY_SUPPLEMENT).toContain("execute it rather than ending with an announcement");
  expect(SWE_AUTONOMY_SUPPLEMENT).not.toContain("one tool call");
  expect(SWE_AUTONOMY_SUPPLEMENT).not.toContain("parallel");
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
