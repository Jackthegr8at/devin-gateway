import { modelCategories } from "./model-categories.js";
import { formatModelDisplayName } from "./model-display.js";
import type { AdminModel } from "./state.js";
export function ModelRow({ model, enabled, disabled, onToggle }: { model: AdminModel; enabled: boolean; disabled: boolean; onToggle(enabled: boolean): void }) {
  const status = !model.available ? "Unavailable" : !model.codex.exportEligible ? "Cannot export" : model.codex.tested ? "Tested" : "Untested";
  return <label className={`model-row${enabled ? " is-enabled" : ""}`} data-model-id={model.id}>
    <input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} aria-label={`Enable ${model.displayName} (${model.id})`} />
    <span className="model-identity"><span className="model-name">{formatModelDisplayName(model.id, model.displayName)}</span><code>{model.id}</code></span>
    <span className="model-badges">
      {modelCategories(model).map((category) => <span className="badge category" key={category}>{category}</span>)}
      <span className={`badge ${!model.codex.exportEligible ? "warning" : model.codex.tested ? "reviewed" : "muted"}`}>{status}</span>
      {model.available ? <span className="availability">Available</span> : null}
      {model.available && !model.codex.exportEligible ? <span className="availability warning">{model.codex.exclusionReason ?? "Structural metadata incomplete"}</span> : null}
    </span>
  </label>;
}
