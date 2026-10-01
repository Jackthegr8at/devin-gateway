import { expect, test } from "bun:test";
import { ChatMessageSource, type ChatMessagePrompt } from "../src/proto.ts";
import {
  CODEX_DESKTOP_SYSTEM_COLLAPSE_ENV,
  collapseSystemPromptIntoLatestUserMessage,
  isCodexDesktopSystemCollapseRequest,
} from "../src/responses-system-collapse.ts";

const prompts: ChatMessagePrompt[] = [
  { messageId: "prior-user", source: ChatMessageSource.USER, prompt: "Earlier user text" },
  { messageId: "prior-assistant", source: ChatMessageSource.SYSTEM, prompt: "Earlier assistant text" },
  {
    messageId: "prior-tool-call",
    source: ChatMessageSource.SYSTEM,
    prompt: "",
    toolCalls: [{ id: "history-call", name: "exec_command", argumentsJson: '{"cmd":"hostname"}' }],
  },
  { messageId: "prior-tool-result", source: ChatMessageSource.TOOL, prompt: "Earlier tool result", toolCallId: "history-call" },
  { messageId: "current-user", source: ChatMessageSource.USER, prompt: "Current user text" },
];

test("system collapse is opt-in, request-shape checked, and limited to the two Devin variants", () => {
  const base = {
    featureFlag: "1",
    modelId: "glm-5-3-flash-low",
    topLevelInstructions: "Codex Desktop base instructions",
    hasInputSystemDeveloperContext: true,
  };
  expect(isCodexDesktopSystemCollapseRequest(base)).toBe(true);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, modelId: "swe-2-medium" })).toBe(true);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, featureFlag: undefined })).toBe(false);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, featureFlag: "0" })).toBe(false);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, modelId: "swe-2-high" })).toBe(false);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, modelId: "other-model" })).toBe(false);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, topLevelInstructions: "" })).toBe(false);
  expect(isCodexDesktopSystemCollapseRequest({ ...base, hasInputSystemDeveloperContext: false })).toBe(false);
  expect(CODEX_DESKTOP_SYSTEM_COLLAPSE_ENV).toBe("DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM");
});

test("collapse preserves exact system content and all history except the latest user prompt", () => {
  const systemPrompt = "Catalog instructions\n\nDesktop developer block\n\nDesktop system block";
  const before = structuredClone(prompts);
  const result = collapseSystemPromptIntoLatestUserMessage(systemPrompt, prompts);
  const expected = `<system>\n${systemPrompt}\n</system>\n\nCurrent user text`;

  expect(result.applied).toBe(true);
  expect(result.systemPrompt).toBe("");
  expect(result.collapsedUserPayload).toBe(expected);
  expect(result.prompts).toHaveLength(prompts.length);
  expect(result.prompts.slice(0, -1)).toEqual(before.slice(0, -1));
  expect(result.prompts.at(-1)).toEqual({ ...before.at(-1), prompt: expected });
  expect(result.prompts[2].toolCalls).toEqual(before[2].toolCalls);
  expect(result.prompts[3]).toEqual(before[3]);
  expect(prompts).toEqual(before);
});

test("collapse is a no-op without system content or a user turn", () => {
  const noUser = [prompts[1], prompts[2], prompts[3]];
  const noUserResult = collapseSystemPromptIntoLatestUserMessage("System", noUser);
  expect(noUserResult).toEqual({ applied: false, systemPrompt: "System", prompts: noUser });
  expect(noUserResult.prompts).toBe(noUser);

  const emptyResult = collapseSystemPromptIntoLatestUserMessage("", prompts);
  expect(emptyResult).toEqual({ applied: false, systemPrompt: "", prompts });
  expect(emptyResult.prompts).toBe(prompts);
});
