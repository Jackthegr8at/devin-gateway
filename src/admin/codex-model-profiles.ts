/** Historical tested variants, informational only. Never a catalog eligibility gate. */
export const CODEX_PROFILE_VERSION = 1;
export interface CodexModelProfile {
  modelId: string;
  defaultReasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  supportedReasoningEfforts: readonly { effort: CodexModelProfile["defaultReasoningEffort"]; description: string }[];
  multiAgentVersion: "v1";
  shellType: "shell_command";
}
const PROFILES: readonly CodexModelProfile[] = Object.freeze([
  Object.freeze({
    modelId: "glm-5-3-flash-low", defaultReasoningEffort: "low",
    supportedReasoningEfforts: Object.freeze([Object.freeze({ effort: "low", description: "Fixed low reasoning variant." })]),
    multiAgentVersion: "v1", shellType: "shell_command",
  }),
  Object.freeze({
    modelId: "swe-2-medium", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: Object.freeze([Object.freeze({ effort: "medium", description: "Fixed medium reasoning variant." })]),
    multiAgentVersion: "v1", shellType: "shell_command",
  }),
]);
export function getCodexModelProfile(modelId: string): CodexModelProfile | undefined {
  return PROFILES.find((profile) => profile.modelId === modelId);
}
