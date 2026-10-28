import { useEffect, useState, type ReactNode } from "react";
import type { AdminModel, ModelSelection } from "./types.js";

/** Disclosure state is UI-only. Controls remain mounted so the draft is never reset. */
export function ConfigurationZone({ models, draft, children }: {
  models: AdminModel[]; draft: ModelSelection; children: ReactNode;
}) {
  const [shortViewport, setShortViewport] = useState(() => window.matchMedia?.("(max-height: 850px)").matches ?? false);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? !shortViewport;
  useEffect(() => {
    const query = window.matchMedia?.("(max-height: 850px)");
    if (!query) return;
    const update = () => setShortViewport(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const summary = (role: "default" | "swe_worker") => {
    const assignment = draft.roles[role];
    const model = models.find((row) => row.id === assignment.modelId || row.family?.id === assignment.modelId);
    return `${model?.family?.displayName ?? model?.displayName ?? assignment.modelId} / ${assignment.effort}`;
  };
  return <section className="configuration-zone" aria-label="Configuration">
    <button type="button" className="configuration-toggle" aria-expanded={expanded} aria-controls="configuration-controls"
      onClick={() => setUserExpanded(!expanded)}>
      <span className="configuration-heading"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>Configuration</span>
      <span className="configuration-summary"><span>Parent: {summary("default")}</span><span>Worker: {summary("swe_worker")}</span></span>
    </button>
    <div id="configuration-controls" className="configuration-controls" hidden={!expanded}>{children}</div>
  </section>;
}
