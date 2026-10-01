import { ChatMessageSource, type ChatMessagePrompt } from "./proto.js";

export const CODEX_DESKTOP_SYSTEM_COLLAPSE_ENV = "DEVIN_CODEX_DESKTOP_COLLAPSE_SYSTEM";
export const CODEX_DESKTOP_COLLAPSE_MODELS = [
  "glm-5-3-flash-low",
  "swe-2-medium",
] as const;

export interface CodexDesktopCollapseRequest {
  featureFlag: string | undefined;
  modelId: unknown;
  topLevelInstructions: unknown;
  hasInputSystemDeveloperContext: boolean;
}

/** Keep this compatibility path opt-in and limited to the validated Desktop request shape. */
export function isCodexDesktopSystemCollapseRequest(options: CodexDesktopCollapseRequest): boolean {
  return options.featureFlag === "1"
    && CODEX_DESKTOP_COLLAPSE_MODELS.some((modelId) => options.modelId === modelId)
    && typeof options.topLevelInstructions === "string"
    && options.topLevelInstructions.length > 0
    && options.hasInputSystemDeveloperContext;
}

export interface CollapsedResponsesSystem {
  applied: boolean;
  systemPrompt: string;
  prompts: ChatMessagePrompt[];
  collapsedUserPayload?: string;
}

/** Move the exact composed system text into the latest user turn without rewriting history. */
export function collapseSystemPromptIntoLatestUserMessage(
  systemPrompt: string,
  prompts: ChatMessagePrompt[],
): CollapsedResponsesSystem {
  if (!systemPrompt) return { applied: false, systemPrompt, prompts };

  let latestUserIndex = -1;
  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    if (prompts[index].source === ChatMessageSource.USER) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) return { applied: false, systemPrompt, prompts };

  const currentUser = prompts[latestUserIndex];
  const collapsedUserPayload = `<system>\n${systemPrompt}\n</system>\n\n${currentUser.prompt}`;
  const nextPrompts = prompts.slice();
  nextPrompts[latestUserIndex] = { ...currentUser, prompt: collapsedUserPayload };
  return {
    applied: true,
    systemPrompt: "",
    prompts: nextPrompts,
    collapsedUserPayload,
  };
}
