import { expect, test } from "bun:test";
import { RESPONSES_BRIDGE_CAPABILITY, withResponsesBridgeInstructions } from "../src/responses-bridge-capability.ts";
import { SWE_AUTONOMY_SUPPLEMENT } from "../src/responses-swe-autonomy.ts";
import { collapseSystemPromptIntoLatestUserMessage } from "../src/responses-system-collapse.ts";
import { ChatMessageSource } from "../src/proto.ts";

const anchor = "Synthetic native anchor\n  Preserve bytes.\n";
test("every Responses model receives a separate single-call bridge capability", () => {
  for (const model of ["swe-2-medium", "swe-2-high", "swe-2-max", "glm-5-3-flash-low", "unrelated-model", "SWE-2-high"]) {
    const composed = withResponsesBridgeInstructions(anchor, model);
    expect(Buffer.from(composed).subarray(0, Buffer.byteLength(anchor))).toEqual(Buffer.from(anchor));
    expect(composed.endsWith(`[Gateway Responses bridge capability]\n${RESPONSES_BRIDGE_CAPABILITY}`)).toBe(true);
    expect(composed.includes(SWE_AUTONOMY_SUPPLEMENT)).toBe(["swe-2-medium", "swe-2-high", "swe-2-max"].includes(model));
  }
  expect(withResponsesBridgeInstructions("", "unrelated-model")).toBe(`[Gateway Responses bridge capability]\n${RESPONSES_BRIDGE_CAPABILITY}`);
});
test("capability states the limit, conflicting batching instruction and sequential continuation", () => {
  for (const phrase of ["only one distinct tool call per response", "Even if other instructions encourage parallel or batched tool use", "do not emit multiple tool calls", "wait for its result in the next turn", "continue with the next necessary action", "does not require stopping the overall task"]) expect(RESPONSES_BRIDGE_CAPABILITY).toContain(phrase);
});
test("collapse orders native content, SWE guidance, capability, and unchanged latest user text", () => {
  const composed = withResponsesBridgeInstructions(anchor, "swe-2-high");
  expect(composed.indexOf(SWE_AUTONOMY_SUPPLEMENT)).toBeLessThan(composed.indexOf(RESPONSES_BRIDGE_CAPABILITY));
  const prompts = [{ messageId: "synthetic", source: ChatMessageSource.USER, prompt: "Synthetic task" }];
  const before = structuredClone(prompts);
  const result = collapseSystemPromptIntoLatestUserMessage(composed, prompts);
  expect(result.systemPrompt).toBe("");
  expect(result.collapsedUserPayload).toBe(`<system>\n${composed}\n</system>\n\nSynthetic task`);
  expect(prompts).toEqual(before);
});
