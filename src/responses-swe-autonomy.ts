import { REVIEWED_FAMILY_ROUTES } from "./model-families.js";

/** Gateway-owned guidance, separate from the reviewed runtime instruction anchor. */
export const SWE_AUTONOMY_SUPPLEMENT = "Continue until the task is complete or genuinely blocked. When another tool action is immediately necessary, execute it rather than ending with an announcement of that action. Issue at most one tool call at a time. After its result is returned, continue with the next necessary action in the following turn. Finish normally when the task is complete. Stop when user input, authorization, approval, or confirmation of a destructive action is required; never bypass those boundaries.";

const sweVariants = new Set(Object.values(REVIEWED_FAMILY_ROUTES["swe-2"]));

/** Match resolved, reviewed wire IDs only; never infer families from prefixes. */
export function withSweAutonomySupplement(instructions: string, resolvedModelId: string): string {
  if (!sweVariants.has(resolvedModelId)) return instructions;
  const supplement = `[Gateway SWE autonomy supplement]\n${SWE_AUTONOMY_SUPPLEMENT}`;
  return instructions ? `${instructions}\n\n${supplement}` : supplement;
}
