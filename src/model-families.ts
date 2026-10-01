import type { DiscoveredModelMetadata } from "./devin.js";

export const FAMILY_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type FamilyEffort = typeof FAMILY_EFFORTS[number];
export interface ModelFamilyMetadata {
  modelFamilyLabel: string;
  entries: { key: string; value: { order: number; name: string } | null }[];
  isDefaultModelInFamily: boolean;
}
export interface ModelFamily {
  id: string;
  displayName: string;
  provenance: "upstream_family_metadata" | "reviewed_fallback";
  lanes: { fast: boolean; context1m: boolean };
  upstreamDefaultEffort: FamilyEffort | null;
  supportsOff: boolean;
  variants: Partial<Record<FamilyEffort, string>>;
}
export class FamilyRoutingError extends Error {
  constructor(message: string) { super(message); }
}
const normalized = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");
function effortName(name: string): FamilyEffort | null {
  const value = normalized(name);
  if (["none", "nothinking", "off"].includes(value)) return "off";
  return FAMILY_EFFORTS.find((effort) => effort === value) ?? null;
}
// Only reviewed exact IDs, never suffix inference. Upstream metadata overrides this.
export const REVIEWED_FAMILY_ROUTES: Readonly<Record<string, Readonly<Partial<Record<FamilyEffort, string>>>>> = Object.freeze({
  "swe-2": Object.freeze({ medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" }),
});
function descriptor(model: DiscoveredModelMetadata): { family: ModelFamily; effort: FamilyEffort; isDefault: boolean } | null {
  const metadata = model.modelFamilyMetadata;
  if (!metadata) {
    for (const [id, routes] of Object.entries(REVIEWED_FAMILY_ROUTES)) {
      for (const [effort, concrete] of Object.entries(routes)) if (concrete === model.id) return {
        family: { id, displayName: "SWE-2", provenance: "reviewed_fallback", lanes: { fast: false, context1m: false }, upstreamDefaultEffort: null, supportsOff: false, variants: {} },
        effort: effort as FamilyEffort, isDefault: model.isDefaultModelInFamily === true,
      };
    }
    return null;
  }
  if (!metadata.modelFamilyLabel.trim()) return null;
  if (metadata.modelFamilyLabel.length > 512 || metadata.entries.length > 64) throw new FamilyRoutingError("Invalid model family metadata size.");
  let effort: FamilyEffort | null = null;
  let thinking: boolean | null = null;
  let fast = false;
  let context1m = false;
  const seen = new Set<string>();
  for (const entry of metadata.entries) {
    const key = normalized(entry.key);
    if (!["effort", "reasoningeffort", "thinking", "fastmode", "1mcontext"].includes(key)) continue;
    if (!entry.value || seen.has(key)) throw new FamilyRoutingError("Ambiguous model family metadata.");
    seen.add(key);
    if (key === "effort" || key === "reasoningeffort") {
      const parsed = effortName(entry.value.name);
      if (!parsed) return null; // Unsupported axes stay standalone, never guessed from the UID.
      if (effort && effort !== parsed) throw new FamilyRoutingError("Conflicting model family effort metadata.");
      effort = parsed;
    } else {
      if (entry.value.order !== 0 && entry.value.order !== 1) return null;
      if (key === "thinking") thinking = entry.value.order === 1;
      else if (key === "fastmode") fast = entry.value.order === 1;
      else context1m = entry.value.order === 1;
    }
  }
  if (thinking === false) {
    // Upstream can label both thinking/non-thinking members High; the explicit axis wins.
    effort = "off";
  }
  if (!effort) return null; // Unknown dimensions are not guessed from the concrete ID.
  if (effort === "off" && thinking === true) throw new FamilyRoutingError("Conflicting non-reasoning family route.");
  const base = metadata.modelFamilyLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!base || base.length > 240) throw new FamilyRoutingError("Invalid model family label.");
  return {
    family: { id: base + (context1m ? "-1m" : "") + (fast ? "-fast" : ""), displayName: metadata.modelFamilyLabel.trim() + (context1m ? " 1M" : "") + (fast ? " Fast" : ""),
      provenance: "upstream_family_metadata", lanes: { fast, context1m }, upstreamDefaultEffort: null, supportsOff: false, variants: {} },
    effort, isDefault: model.isDefaultModelInFamily === true || metadata.isDefaultModelInFamily,
  };
}
/** Order-independent; ambiguous routes/default markers fail closed rather than first-wins. */
export function projectModelFamilies(models: readonly DiscoveredModelMetadata[]): ModelFamily[] {
  const descriptors = models.flatMap((model) => { const value = descriptor(model); return value ? [{ ...value, modelId: model.id }] : []; });
  const authoritative = new Set(descriptors.filter((value) => value.family.provenance === "upstream_family_metadata").map((value) => value.family.id));
  const groups = new Map<string, ModelFamily>();
  for (const { family, effort, isDefault, modelId } of descriptors) {
    if (family.provenance === "reviewed_fallback" && authoritative.has(family.id)) continue;
    const current = groups.get(family.id) ?? family;
    if (current.displayName !== family.displayName || current.variants[effort]) throw new FamilyRoutingError("Ambiguous model family route.");
    current.variants[effort] = modelId;
    if (isDefault) {
      if (current.upstreamDefaultEffort !== null) throw new FamilyRoutingError("Ambiguous model family default.");
      current.upstreamDefaultEffort = effort;
    }
    current.supportsOff = !!current.variants.off;
    groups.set(current.id, current);
  }
  for (const family of groups.values()) if (models.some((model) => model.id === family.id && !Object.values(family.variants).includes(model.id))) throw new FamilyRoutingError("Family ID conflicts with a concrete model.");
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)).map((family) => ({ ...family,
    variants: Object.fromEntries(FAMILY_EFFORTS.filter((effort) => family.variants[effort]).map((effort) => [effort, family.variants[effort]])),
  }));
}
export function resolveFamilyModelId(modelId: string, effort: unknown, families: readonly ModelFamily[]): string {
  const family = families.find((entry) => entry.id === modelId);
  if (!family) {
    if (Object.hasOwn(REVIEWED_FAMILY_ROUTES, modelId)) throw new FamilyRoutingError("Logical model family is unavailable; no model was substituted.");
    return modelId; // Existing concrete-ID behavior, including unknown direct IDs, is unchanged.
  }
  if (typeof effort !== "string" || !Object.hasOwn(family.variants, effort)) throw new FamilyRoutingError("An explicit supported reasoning effort is required for this logical model family.");
  return family.variants[effort as FamilyEffort]!;
}
