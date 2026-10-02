// Interaction model adapted from Cody ModelCurationDialog.tsx (MIT, Copyright (c) 2026 agegr).
import { useEffect, useMemo, useRef, useState } from "react";
import { createPickerApi, PickerApiError, type PickerApi } from "./api.js";
import { MODEL_CATEGORY_OPTIONS, modelCategoryBucket, type ModelCategory } from "./model-categories.js";
import { getModelPageWindow } from "./model-pagination.js";
import { ModelRow } from "./ModelRow.js";
import { RoleAssignments } from "./RoleAssignments.js";
import { orderFamilyVariants } from "./effort-order.js";
import { allDiscoveredEnabled, bulkSelection, createDraft, draftErrors, draftsEqual, matchingModels, type ModelSelection, type Snapshot } from "./state.js";

const defaultApi = createPickerApi();
export function ModelPicker({ api = defaultApi }: { api?: PickerApi }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<ModelSelection | null>(null);
  const [query, setQuery] = useState("");
  const [categories, setCategories] = useState<Set<ModelCategory>>(() => new Set());
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState("Loading Devin models…");
  const searchRef = useRef<HTMLInputElement>(null);
  const categoriesRef = useRef<HTMLDetailsElement>(null);
  const mounted = useRef(true);
  const actionPending = useRef(false);
  const baseline = snapshot ? createDraft(snapshot.selection, snapshot.models) : null;
  const dirty = !!draft && !!baseline && !draftsEqual(draft, baseline);

  function resetFilters() { setQuery(""); setCategories(new Set()); setEnabledOnly(false); setPageIndex(0); }
  async function load() {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true); setError(""); setStatus("Loading Devin models…");
    try {
      const next = await api.load();
      if (!mounted.current) return;
      setSnapshot(next); setDraft(createDraft(next.selection, next.models)); setConflict(false); resetFilters();
      setStatus(`Loaded selection revision ${next.selection.revision}.`);
      requestAnimationFrame(() => searchRef.current?.focus());
    } catch (failure) { if (mounted.current) { setError(failure instanceof PickerApiError ? failure.message : "Could not load the picker. Check the gateway and reload."); setStatus(""); } }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [api]);
  useEffect(() => {
    const closeCategories = (event: Event) => {
      const details = categoriesRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", closeCategories);
    document.addEventListener("focusin", closeCategories);
    return () => {
      document.removeEventListener("pointerdown", closeCategories);
      document.removeEventListener("focusin", closeCategories);
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const matches = useMemo(() => snapshot && draft ? orderFamilyVariants(matchingModels(snapshot.models, draft, { query, categories, enabledOnly })) : [], [snapshot, draft, query, categories, enabledOnly]);
  const page = getModelPageWindow(matches.length, pageIndex);
  const visible = matches.slice(page.start, page.end);
  const groups = new Map<string, typeof visible>();
  for (const model of visible) { const key = model.family?.id ?? model.id; groups.set(key, [...groups.get(key) ?? [], model]); }
  const errors = draft && snapshot ? draftErrors(draft, snapshot.models) : [];
  const enabled = new Set(draft?.enabledModels ?? []);
  const discovered = snapshot?.models.filter((model) => model.available) ?? [];
  const enabledDiscovered = discovered.filter((model) => enabled.has(model.id)).length;
  const unavailableEnabled = snapshot?.models.filter((model) => !model.available && enabled.has(model.id)).length ?? 0;
  const allSelected = !!draft && !!snapshot && allDiscoveredEnabled(draft, snapshot.models);
  const filtered = !!query.trim() || categories.size > 0 || enabledOnly;
  function bulk(ids: string[], on: boolean) { setDraft((previous) => previous ? bulkSelection(previous, ids, on) : previous); }
  function cancel() {
    if (busy || !snapshot) return;
    setDraft(createDraft(snapshot.selection, snapshot.models)); resetFilters();
    if (!conflict) setError("");
    setStatus("Draft discarded. Saved settings are unchanged."); searchRef.current?.focus();
  }
  async function save() {
    if (actionPending.current || busy || conflict || !draft || !snapshot || !dirty || errors.length) return;
    actionPending.current = true; setBusy(true); setError(""); setStatus("Saving complete selection…");
    try {
      const result = await api.save(draft, snapshot.etag);
      if (!mounted.current) return;
      const next = { ...snapshot, ...result };
      setSnapshot(next); setDraft(createDraft(result.selection, snapshot.models)); setConflict(false);
      setStatus(`Selection saved. Revision ${result.selection.revision}.`);
    } catch (failure) {
      if (mounted.current) {
        setConflict(failure instanceof PickerApiError && failure.status === 412);
        setError(failure instanceof PickerApiError ? failure.message : "Save could not be confirmed. Your draft is retained; reload to check the saved state."); setStatus("");
      }
    } finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  }

  return <main className="picker" aria-labelledby="picker-title" aria-busy={busy} onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) {
      const details = event.currentTarget.querySelector("details[open]");
      if (details) { details.removeAttribute("open"); details.querySelector("summary")?.focus(); }
      else cancel();
      event.preventDefault();
    }
  }}>
    <header className="picker-header"><div><span className="eyebrow">DEVIN GATEWAY</span><h1 id="picker-title">Devin models</h1></div><span className="header-label">Model selection</span></header>
    <div className="picker-body">
      <p className="counts"><strong>{enabledDiscovered}</strong> of <strong>{discovered.length}</strong> discovered models enabled{unavailableEnabled ? ` · ${unavailableEnabled} saved unavailable` : ""}.</p>
      <p className="intro">Curate the gateway selection and choose its model roles. Changes stay in this draft until you save.</p>
      <div className="feedback" role="status" aria-live="polite" aria-atomic="true">{status}</div>
      {error ? <div className="error" role="alert"><p>{error}</p>{conflict || !snapshot ? <button type="button" disabled={busy} onClick={() => void load()}>{conflict ? "Reload latest (discard draft)" : "Retry loading"}</button> : null}</div> : null}
      {snapshot && draft ? <>
        <fieldset className="edit-controls" disabled={busy}>
          <label className="future-control"><span><span className="control-title">Include future Devin models</span><span className="help" id="future-help">{allSelected
            ? "Enable future discoveries. New models never receive roles automatically."
            : "Partial selections save exact IDs. Enable all for future models; disabling a model turns future inclusion off."}</span></span>
            <input type="checkbox" aria-describedby="future-help" checked={draft.includeFutureModels} disabled={!allSelected || busy} onChange={(event) => setDraft({ ...draft, includeFutureModels: event.target.checked })} />
          </label>
          <RoleAssignments models={snapshot.models} draft={draft} disabled={busy} onChange={(role, id) => setDraft((previous) => previous ? { ...previous, roles: { ...previous.roles, [role]: id } } : previous)} />
          {errors.length ? <div className="validation" role="alert" id="draft-errors">{errors.map((message) => <p key={message}>{message}</p>)}</div> : null}
          <div className="filters">
            <label className="search"><span className="sr-only">Search Devin models</span><input ref={searchRef} type="search" placeholder={`Search ${discovered.length} models…`} value={query} onChange={(event) => { setQuery(event.target.value); setPageIndex(0); }} /></label>
            <details ref={categoriesRef} className="categories"><summary><span>{categories.size ? MODEL_CATEGORY_OPTIONS.filter((category) => categories.has(category)).join(" + ") : "All categories"}</span><svg className="category-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></summary>
              <div className="category-menu" role="group" aria-label="Model categories"><span className="help">Select any categories</span>{MODEL_CATEGORY_OPTIONS.map((category) => <label key={category}><input type="checkbox" checked={categories.has(category)} onChange={() => { setCategories((previous) => { const next = new Set(previous); if (next.has(category)) next.delete(category); else next.add(category); return next; }); setPageIndex(0); }} /><span>{category}</span><small>{snapshot.models.filter((model) => modelCategoryBucket(model) === category).length}</small></label>)}</div>
            </details>
            <label className="enabled-only"><input type="checkbox" checked={enabledOnly} onChange={(event) => { setEnabledOnly(event.target.checked); setPageIndex(0); }} />Enabled only</label>
          </div>
          <div className="bulk-actions"><button type="button" disabled={!matches.length} onClick={() => bulk(matches.map((model) => model.id), true)}>Enable {filtered ? `these ${matches.length}` : "all"}</button><button type="button" disabled={!matches.length} onClick={() => bulk(matches.map((model) => model.id), false)}>Disable {filtered ? `these ${matches.length}` : "all"}</button><span>Applies to every match, across all pages.</span></div>
          <div className="model-list" role="group" aria-label="Devin model selection">
            {visible.length ? [...groups].map(([id, models]) => models[0].family ? <section key={id} className="model-family" aria-label={`${models[0].family.displayName} variants`}>
              <h3>{models[0].family.displayName}</h3><p className="help">Thinking variants · {models[0].family.provenance === "upstream_family_metadata" ? "Devin family metadata" : "Reviewed fallback"}{models[0].family.upstreamDefaultEffort ? ` · upstream default ${models[0].family.upstreamDefaultEffort}` : ""}</p>
              {models.map((model) => <ModelRow key={model.id} model={{ ...model, displayName: `${model.family!.effort} · ${model.displayName}` }} enabled={enabled.has(model.id)} disabled={busy} onToggle={(on) => bulk([model.id], on)} />)}
            </section> : <ModelRow key={id} model={models[0]} enabled={enabled.has(id)} disabled={busy} onToggle={(on) => bulk([id], on)} />)
              : <p className="empty">{enabledOnly ? "No enabled models match these filters. Turn off Enabled only to add models." : "No models match these filters. Try another search or category."}</p>}
          </div>
          <nav className="pagination" aria-label="Devin model pages"><span aria-live="polite">{matches.length ? `Showing ${page.start + 1}–${page.end} of ${matches.length}` : "0 matching models"}</span><div><button type="button" disabled={page.pageIndex === 0} onClick={() => setPageIndex(page.pageIndex - 1)}>Previous</button><span>Page {page.pageIndex + 1} of {page.pageCount}</span><button type="button" disabled={page.pageIndex === page.pageCount - 1} onClick={() => setPageIndex(page.pageIndex + 1)}>Next</button></div></nav>
        </fieldset>
      </> : null}
    </div>
    <footer className="picker-footer"><span>{dirty ? "Unsaved changes" : snapshot ? `Saved revision ${snapshot.selection.revision}` : "Management listener only"}</span><div><button type="button" disabled={busy || !snapshot} onClick={cancel}>Cancel</button><button className="primary" type="button" disabled={busy || !dirty || !!errors.length || conflict} aria-describedby={errors.length ? "draft-errors" : undefined} onClick={() => void save()}>{busy && snapshot ? "Saving…" : "Save selection"}</button></div></footer>
  </main>;
}
