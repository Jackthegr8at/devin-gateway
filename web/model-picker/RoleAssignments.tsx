import { ROLES, roleEligible, type AdminModel, type ModelSelection } from "./state.js";
import type { ModelRole } from "./types.js";
import { compareEfforts } from "./effort-order.js";
export function RoleAssignments({ models, draft, disabled, onChange }: { models: AdminModel[]; draft: ModelSelection; disabled: boolean; onChange(role: typeof ROLES[number], assignment: ModelRole): void }) {
  const options = models.filter((model) => roleEligible(model, draft));
  const logicalId = (model: AdminModel) => Object.values(draft.roles).some((role) => role.modelId === model.id) ? model.id : model.family?.id ?? model.id;
  const effort = (model: AdminModel) => model.family?.effort ?? model.codex.profile!.defaultReasoningEffort;
  return <section className="roles" aria-labelledby="roles-title">
    <div className="section-heading"><h2 id="roles-title">Model roles</h2><span>Enabled, reviewed models only</span></div>
    <div className="role-grid">{ROLES.map((role) => {
      const label = role === "default" ? "Default / parent" : "swe_worker";
      const assignment = draft.roles[role];
      const eligible = options.filter((model) => logicalId(model) === assignment.modelId).sort((a, b) => compareEfforts(effort(a), effort(b)));
      const selected = eligible.find((model) => effort(model) === assignment.effort);
      const ids = [...new Set(options.map(logicalId))];
      return <div key={role} className="role-field"><label><span>{label}</span>
        <select aria-label={`${label} model`} aria-invalid={!selected} aria-describedby="role-help" value={assignment.modelId} disabled={disabled} onChange={(event) => {
          const model = options.find((model) => logicalId(model) === event.target.value)!;
          onChange(role, { modelId: logicalId(model), effort: effort(model) });
        }}>
          {!ids.includes(assignment.modelId) ? <option value={assignment.modelId}>{assignment.modelId} — re-enable or reassign</option> : null}
          {ids.map((id) => { const model = options.find((model) => logicalId(model) === id)!; return <option value={id} key={id}>{model.family?.displayName ?? model.displayName}</option>; })}
        </select></label>
        <label><span>Thinking</span><select aria-label={`${label} thinking`} aria-invalid={!selected} value={assignment.effort} disabled={disabled || !eligible.length} onChange={(event) => onChange(role, { ...assignment, effort: event.target.value })}>
          {!selected ? <option value={assignment.effort}>{assignment.effort} — unavailable</option> : null}
          {eligible.map((model) => <option key={model.id} value={effort(model)}>{effort(model)}</option>)}
        </select></label>
      </div>;
    })}</div>
    <p id="role-help" className="help">Only enabled, available, reviewed efforts can receive roles. Upstream defaults do not replace your saved effort.</p>
  </section>;
}
