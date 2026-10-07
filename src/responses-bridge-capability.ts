import { withSweAutonomySupplement } from "./responses-swe-autonomy.js";

/** Representation guidance for the strict, model-independent Responses bridge. */
export const RESPONSES_BRIDGE_CAPABILITY = "This bridge can execute only one distinct tool call per response. Even if other instructions encourage parallel or batched tool use, do not emit multiple tool calls in the same response. Emit one required tool call, wait for its result in the next turn, then continue with the next necessary action. This execution constraint does not require stopping the overall task.";

/** Preserve native bytes; place the bridge constraint after model-specific guidance. */
export function withResponsesBridgeInstructions(instructions: string, resolvedModelId: string): string {
  const composed = withSweAutonomySupplement(instructions, resolvedModelId);
  const capability = `[Gateway Responses bridge capability]\n${RESPONSES_BRIDGE_CAPABILITY}`;
  return composed ? `${composed}\n\n${capability}` : capability;
}
