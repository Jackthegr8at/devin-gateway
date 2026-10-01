import type { DiscoveredModelMetadata } from "../../src/devin.ts";
import { ProtoEncoder } from "../../src/proto.ts";
import type { FamilyEffort } from "../../src/model-families.ts";
export function familyFixture(id: string, label?: string, effort?: FamilyEffort, lanes: { fast?: boolean; context1m?: boolean } = {}, marker = false): DiscoveredModelMetadata {
  return { id, name: id, contextWindow: 262000, maxTokens: 128000, reasoning: effort !== "off", supportsImages: true,
    upstreamThinking: effort === "off" ? false : true,
    metadataProvenance: { id: "upstream", displayName: "upstream", contextWindow: "upstream", maxOutputTokens: "upstream", imageSupport: "upstream", upstreamThinking: "upstream", reasoning: "upstream_indicator_and_label_heuristic" },
    ...(label ? { modelFamilyMetadata: { modelFamilyLabel: label, isDefaultModelInFamily: marker, entries: [
      { key: "effort", value: { name: effort!, order: 0 } },
      ...(lanes.fast ? [{ key: "Fast Mode", value: { name: "Fast", order: 1 } }] : []),
      ...(lanes.context1m ? [{ key: "1M Context", value: { name: "1M", order: 1 } }] : []),
    ] } } : {}),
  };
}
export function familyPayload(models: DiscoveredModelMetadata[]): Uint8Array {
  const enc = new ProtoEncoder();
  for (const model of models) enc.message(1, (e) => {
    e.string(1, model.name); e.string(22, model.id); e.uint32(18, model.contextWindow); e.bool(5, model.supportsImages);
    e.message(23, (info) => { info.uint32(13, model.maxTokens); info.message(6, (features) => features.bool(15, model.upstreamThinking === true)); });
    if (model.modelFamilyMetadata) e.message(30, (family) => {
      family.string(1, model.modelFamilyMetadata!.modelFamilyLabel); family.bool(3, model.modelFamilyMetadata!.isDefaultModelInFamily);
      for (const entry of model.modelFamilyMetadata!.entries) family.message(2, (row) => {
        row.string(1, entry.key); if (entry.value) row.message(2, (value) => { value.uint32(1, entry.value!.order); value.string(2, entry.value!.name); });
      });
    });
    e.bool(31, model.isDefaultModelInFamily);
  });
  return enc.finish();
}
