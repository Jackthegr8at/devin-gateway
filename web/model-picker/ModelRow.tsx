import { modelCategories } from "./model-categories.js";
import { formatModelDisplayName } from "./model-display.js";
import type { AdminModel } from "./state.js";
export function ModelRow({ model, enabled, disabled, onToggle, onMark }: { model: AdminModel; enabled: boolean; disabled: boolean; onToggle(enabled: boolean): void; onMark?(status: "tested" | "untested"): void }) {
  const status = !model.available ? "Unavailable" : !model.codex.exportEligible ? "Cannot export" : model.codex.tested ? "Tested" : "Untested";
  const details = model.testStatus?.source === "manual" ? `Marked ${model.testStatus.status} manually` : model.testStatus?.source === "automatic" ? "Tested automatically" : "No completed tool validation";
  const tooltip = `${details}${model.testStatus?.lastSuccessAt ? ` · Last successful validation: ${model.testStatus.lastSuccessAt}` : ""}`;
  return <div className={`model-row${enabled ? " is-enabled" : ""}`} data-model-id={model.id}>
    <label className="model-toggle"><input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} aria-label={`Enable ${model.displayName} (${model.id})`} />
    <span className="model-identity"><span className="model-name">{formatModelDisplayName(model.id, model.displayName)}</span><code>{model.id}</code></span></label>
    <span className="model-badges">
      {modelCategories(model).map((category) => <span className="badge category" key={category}>{category}</span>)}
      <span title={tooltip} className={`badge ${!model.codex.exportEligible ? "warning" : model.codex.tested ? "reviewed" : "muted"}`}>{status}</span>
      {onMark ? <button type="button" className="test-status-action" disabled={disabled} aria-label={`${model.codex.tested ? "Mark untested" : "Mark tested"}: ${model.id}`} title="Saves immediately; does not change model selection" onClick={() => onMark(model.codex.tested ? "untested" : "tested")}>{model.codex.tested ? "Mark untested" : "Mark tested"}</button> : null}
      {model.available ? <span className="availability">Available</span> : null}
      {model.available && !model.codex.exportEligible ? <span className="availability warning">{model.codex.exclusionReason ?? "Structural metadata incomplete"}</span> : null}
    </span>
  </div>;
}
