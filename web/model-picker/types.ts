/** Browser DTOs for the Phase 2.5 JSON contract; no server modules enter the browser graph. */
export interface ModelSelection {
  schemaVersion: 2;
  revision: number;
  enabledModels: string[];
  roles: { default: ModelRole; swe_worker: ModelRole };
  includeFutureModels: boolean;
}
export interface ModelRole { modelId: string; effort: string }
export interface AdminModel {
  family?: { id: string; displayName: string; effort: string; provenance: string; upstreamDefaultEffort: string | null };
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
    status: "tested" | "untested" | "cannot_export";
    tested?: boolean;
    exclusionReason?: string | null;
    exportEligible: boolean;
    profile: {
      modelId: string;
      defaultReasoningEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
      supportedReasoningEfforts: readonly { effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"; description: string }[];
      multiAgentVersion: "v1";
      shellType: "shell_command";
    } | null;
  };
}
