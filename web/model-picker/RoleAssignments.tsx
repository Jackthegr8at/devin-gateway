import { ROLES, roleEligible, type AdminModel, type ModelSelection } from "./state.js";
export function RoleAssignments({ models, draft, disabled, onChange }: { models: AdminModel[]; draft: ModelSelection; disabled: boolean; onChange(role: typeof ROLES[number], id: string): void }) {
  const options = models.filter((model) => roleEligible(model, draft));
  return <section className="roles" aria-labelledby="roles-title">
    <div className="section-heading"><h2 id="roles-title">Model roles</h2><span>Enabled, reviewed models only</span></div>
    <div className="role-grid">{ROLES.map((role) => {
      const label = role === "default" ? "Default / parent" : "swe_worker";
      const selected = models.find((model) => model.id === draft.roles[role]);
      const invalid = !selected || !roleEligible(selected, draft);
      return <label key={role} className="role-field"><span>{label}</span>
        <select aria-label={`${label} model`} aria-invalid={invalid} aria-describedby="role-help" value={draft.roles[role]} disabled={disabled} onChange={(event) => onChange(role, event.target.value)}>
          {invalid ? <option value={draft.roles[role]}>{draft.roles[role]} — re-enable or reassign</option> : null}
          {options.map((model) => <option value={model.id} key={model.id}>{model.displayName} · {model.codex.profile?.defaultReasoningEffort}</option>)}
        </select>
      </label>;
    })}</div>
    <p id="role-help" className="help">Role models keep their reviewed fixed reasoning effort. Categories are display labels, not capabilities. Both roles are required by the current gateway contract.</p>
  </section>;
}
