import { REVIEWED_FAMILY_ROUTES } from "./model-families.js";
import { StopReason } from "./proto.js";

export const SWE_AUTONOMOUS_CONTINUATION_ENV = "DEVIN_SWE_AUTONOMOUS_CONTINUATION";
export const SWE_COMPLETION_INSTRUCTION = `You are operating as an autonomous agent inside Codex.

Continue working until the user's requested task is completed.

When you have completed the task, append this exact marker on its own final line:

[PROCESS_DONE]

If further work remains, do not output this marker.
Instead, execute the necessary tool calls.

Do not end with statements announcing actions that you have not performed.

If a genuine blocker requires human intervention and you cannot continue, explain the blocker and end with [PROCESS_DONE] to return control to the user.

The marker must only appear at the end of a final response.`;

/** Gateway-owned guidance, separate from the reviewed runtime instruction anchor. */
export const SWE_AUTONOMY_SUPPLEMENT = "Continue until the task is complete or genuinely blocked. When another tool action is immediately necessary, execute it rather than ending with an announcement of that action. Finish normally when the task is complete. Stop when user input, authorization, approval, or confirmation of a destructive action is required; never bypass those boundaries.";

const sweVariants = new Set(Object.values(REVIEWED_FAMILY_ROUTES["swe-2"]));

/** Append on every request; never mutate history or the native instruction anchor. */
export function withSweCompletionInstruction(instructions: string, resolvedModelId: string, enabled: boolean): string {
  if (!enabled || !sweVariants.has(resolvedModelId)) return instructions;
  return `${instructions}${instructions ? "\n\n" : ""}[Gateway SWE completion protocol]\n${SWE_COMPLETION_INSTRUCTION}`;
}

/** Undefined preserves legacy Responses behavior, including tools and truncation. */
export function sweResponseEndTurn(resolvedModelId: string, enabled: boolean, text: string, stopReason: number, toolCallCount: number): boolean | undefined {
  if (!enabled || !sweVariants.has(resolvedModelId) || toolCallCount !== 0 || stopReason === StopReason.MAX_TOKENS) return undefined;
  if (text.trimEnd().split(/\r?\n/).at(-1) === "[PROCESS_DONE]") return true;
  return stopReason === StopReason.STOP_PATTERN ? false : undefined;
}

/** Match resolved, reviewed wire IDs only; never infer families from prefixes. */
export function withSweAutonomySupplement(instructions: string, resolvedModelId: string): string {
  if (!sweVariants.has(resolvedModelId)) return instructions;
  const supplement = `[Gateway SWE autonomy supplement]\n${SWE_AUTONOMY_SUPPLEMENT}`;
  return instructions ? `${instructions}\n\n${supplement}` : supplement;
}
