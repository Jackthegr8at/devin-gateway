/** Browser DTOs for the Phase 1 JSON contract; no server modules enter the browser graph. */
export interface ModelSelection {
  schemaVersion: 1;
  revision: number;
  enabledModels: string[];
  roles: { default: string; swe_worker: string };
  includeFutureModels: boolean;
}
export interface AdminModel {
  id: string;
  displayName: string;
  available: boolean;
  enabled: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean | null;
  upstreamThinking: boolean | null;
  metadataProvenance: Record<string, string> | null;
  codex: {
    status: "validated" | "unvalidated";
    exportEligible: boolean;
    profile: {
      modelId: string;
      defaultReasoningEffort: "low" | "medium";
      supportedReasoningEfforts: readonly { effort: "low" | "medium"; description: string }[];
      multiAgentVersion: "v1";
      shellType: "shell_command";
    } | null;
  };
}
