import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ACCOUNT_PROFILE_IDS, ACCOUNTS_MESSAGES, AccountsApiError,
  type AccountCredentialState, type AccountProfile, type AccountProfileId, type AccountsApi, type AccountsSnapshot, type AccountsUpdate,
} from "./accounts.js";

type Names = Record<AccountProfileId, string>;

const PROFILE_LABELS: Record<AccountProfileId, string> = { personal: "Personal", team: "Team" };
const CREDENTIAL_DISPLAY: Record<AccountCredentialState, { label: string; badge: string }> = {
  configured: { label: "Signed in", badge: "reviewed" },
  unconfigured: { label: "Not signed in", badge: "muted" },
  invalid: { label: "Needs re-enrollment", badge: "warning" },
};
const SIGN_IN_HELP: Record<Exclude<AccountCredentialState, "configured">, string> = {
  unconfigured: "Sign in from the server terminal first.",
  invalid: "Sign in again from the server terminal first.",
};

const STATIC_OVERRIDE_NOTICE = "A static Devin key is set on this gateway. Requests use that key, not the selected account, and switching is disabled until it is removed.";
const STATIC_OVERRIDE_HELP = "Switching is disabled while a static Devin key is set on this gateway.";

function namesOf(profiles: readonly AccountProfile[]): Names {
  const names: Names = { personal: "", team: "" };
  for (const profile of profiles) names[profile.id] = profile.name;
  return names;
}
function nameOf(snapshot: AccountsSnapshot, id: AccountProfileId): string {
  return snapshot.profiles.find((profile) => profile.id === id)?.name ?? PROFILE_LABELS[id];
}
/** Sends the saved names, so activating a profile never saves a name the operator is still editing. */
function savedUpdate(snapshot: AccountsSnapshot, activeProfileId: AccountProfileId): AccountsUpdate {
  return { activeProfileId, profiles: snapshot.profiles.map(({ id, name }) => ({ id, name })) };
}
/** Keeps any name the operator is still editing, and takes the server name for every other field. */
function mergeNames(before: AccountsSnapshot, drafts: Names, after: AccountsSnapshot): Names {
  const saved = namesOf(before.profiles);
  const merged = namesOf(after.profiles);
  for (const id of ACCOUNT_PROFILE_IDS) if (drafts[id] !== saved[id]) merged[id] = drafts[id];
  return merged;
}

/** Accounts section for the picker. It reads and writes only names and the active profile, never credentials. */
export function AccountsZone({ api }: { api: AccountsApi }) {
  const [snapshot, setSnapshot] = useState<AccountsSnapshot | null>(null);
  const [names, setNames] = useState<Names>({ personal: "", team: "" });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [reloadNeeded, setReloadNeeded] = useState(false);
  /** Target of a switch the operator has asked for but not yet confirmed. Nothing is sent until Confirm. */
  const [pendingSwitch, setPendingSwitch] = useState<AccountProfileId | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const useButtons = useRef<Partial<Record<AccountProfileId, HTMLButtonElement | null>>>({});
  const pending = useRef(false);
  const mounted = useRef(true);
  const restoreFocus = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const saved = snapshot ? namesOf(snapshot.profiles) : null;
  const dirty = !!saved && ACCOUNT_PROFILE_IDS.some((id) => names[id].trim() !== saved[id].trim());
  const namesValid = ACCOUNT_PROFILE_IDS.every((id) => names[id].trim() !== "");

  useEffect(() => {
    mounted.current = true;
    load();
    return () => { mounted.current = false; };
  }, [api]);

  // A reload can report a static key while a switch is waiting for Confirm. Drop that switch so it cannot reappear later, and keep focus in the section.
  useEffect(() => {
    if (!snapshot?.staticOverride || !pendingSwitch) return;
    setPendingSwitch(null);
    headingRef.current?.focus();
  }, [snapshot?.staticOverride]);

  // The control that started a request is disabled while it runs, and focus can drop to the body. Move it to the heading so keyboard users keep their place.
  useEffect(() => {
    if (busy || !restoreFocus.current) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [busy]);

  /** Runs one request at a time. Controls are disabled while it is pending. */
  async function perform(pendingText: string, fallback: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(""); setStatus(pendingText);
    try { await action(); }
    catch (failure) { if (mounted.current) await recover(failure, fallback); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  /** A 412 means another client changed the accounts. Reload the latest state and say so; unsaved name edits are replaced. */
  async function recover(failure: unknown, fallback: string) {
    const message = failure instanceof AccountsApiError ? failure.message : fallback;
    if (!(failure instanceof AccountsApiError) || failure.status !== 412) {
      setStatus(""); setError(message); return;
    }
    try {
      const latest = await api.load();
      if (!mounted.current) return;
      setSnapshot(latest); setNames(namesOf(latest.profiles)); setStatus(""); setError(message); setReloadNeeded(false);
    } catch {
      if (!mounted.current) return;
      setStatus(""); setError(ACCOUNTS_MESSAGES.conflictReloadFailed); setReloadNeeded(true);
    }
  }

  function load() {
    void perform("Loading accounts…", ACCOUNTS_MESSAGES.load, async () => {
      const next = await api.load();
      if (!mounted.current) return;
      setSnapshot(next); setNames(namesOf(next.profiles)); setStatus(""); setReloadNeeded(false);
    });
  }

  /** Opens the confirmation. The switch itself is sent only by confirmSwitch. */
  function requestSwitch(id: AccountProfileId) {
    if (!snapshot || snapshot.staticOverride || pending.current) return;
    const target = snapshot.profiles.find((profile) => profile.id === id);
    if (!target || target.credentialState !== "configured" || id === snapshot.activeProfileId) return;
    setPendingSwitch(id);
  }

  function cancelSwitch() {
    const id = pendingSwitch;
    setPendingSwitch(null);
    if (id) queueMicrotask(() => useButtons.current[id]?.focus());
  }

  function confirmSwitch() {
    const id = pendingSwitch;
    setPendingSwitch(null);
    if (id) activate(id);
  }

  function activate(id: AccountProfileId) {
    if (!snapshot || snapshot.staticOverride || pending.current) return;
    const current = snapshot;
    const target = current.profiles.find((profile) => profile.id === id);
    if (!target || target.credentialState !== "configured" || id === current.activeProfileId) return;
    restoreFocus.current = true;
    void perform("Updating the active account…", ACCOUNTS_MESSAGES.update, async () => {
      const next = await api.save(savedUpdate(current, id), current.etag);
      if (!mounted.current) return;
      setSnapshot(next);
      setNames((drafts) => mergeNames(current, drafts, next));
      setStatus(`Active account is now ${nameOf(next, next.activeProfileId)}. New requests use this account.`);
    });
  }

  function saveNames(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !dirty || !namesValid || pending.current) return;
    const current = snapshot;
    const draft = names;
    restoreFocus.current = true;
    void perform("Saving account names…", ACCOUNTS_MESSAGES.update, async () => {
      const next = await api.save({ activeProfileId: current.activeProfileId, profiles: ACCOUNT_PROFILE_IDS.map((id) => ({ id, name: draft[id] })) }, current.etag);
      if (!mounted.current) return;
      setSnapshot(next); setNames(namesOf(next.profiles)); setStatus("Account names saved.");
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Stop Escape here so it does not cancel the model draft in the parent picker.
    if (event.key === "Escape") event.stopPropagation();
  }

  return <section className="accounts" aria-labelledby="accounts-title" aria-busy={busy} onKeyDown={onKeyDown}>
    <div className="section-heading"><h2 id="accounts-title" ref={headingRef} tabIndex={-1}>Accounts</h2><span>Devin sign-in profiles</span></div>
    <p className="help" id="accounts-warning">Changing the active Devin account affects subsequent gateway requests, potentially including requests from a Codex task already in progress. Switch accounts between tasks whenever possible. Requests that send their own Authorization or x-api-key header use that credential, not the selected account.</p>
    <div className="feedback" role="status" aria-live="polite" aria-atomic="true">{status}</div>
    {error ? <div className="error" role="alert"><p>{error}</p>{!snapshot || reloadNeeded ? <button type="button" disabled={busy} onClick={load}>Retry loading accounts</button> : null}</div> : null}
    {snapshot ? <form className="accounts-form" onSubmit={saveNames}>
      <div className="account-notice-region" role="status">{snapshot.staticOverride ? <p className="account-notice">{STATIC_OVERRIDE_NOTICE}</p> : null}</div>
      <fieldset className="account-controls" disabled={busy}>
        <ul className="account-list">{snapshot.profiles.map((profile) => {
          const active = profile.id === snapshot.activeProfileId;
          const label = PROFILE_LABELS[profile.id];
          const display = CREDENTIAL_DISPLAY[profile.credentialState];
          const helpId = `account-help-${profile.id}`;
          const canUse = profile.credentialState === "configured" && !active && !snapshot.staticOverride;
          const reasons = [snapshot.staticOverride ? STATIC_OVERRIDE_HELP : null, profile.credentialState === "configured" ? null : SIGN_IN_HELP[profile.credentialState]];
          const help = reasons.filter(Boolean).join(" ") || null;
          return <li key={profile.id} className={`account-row${active ? " is-active" : ""}`} data-profile-id={profile.id}>
            <div className="account-name-field">
              <label htmlFor={`account-name-${profile.id}`}>Name for {label}</label>
              <input id={`account-name-${profile.id}`} className="account-name-input" type="text" autoComplete="off" spellCheck={false} aria-invalid={names[profile.id].trim() === "" || undefined}
                value={names[profile.id]} onChange={(event) => { const value = event.target.value; setNames((drafts) => ({ ...drafts, [profile.id]: value })); }} />
            </div>
            <div className="account-status">
              {active ? <span className="badge active-marker">Active</span> : null}
              <span className={`badge ${display.badge}`}>{display.label}</span>
            </div>
            <button type="button" disabled={!canUse} aria-describedby={help ? helpId : undefined} ref={(node) => { useButtons.current[profile.id] = node; }} onClick={() => requestSwitch(profile.id)}>Use {profile.name}</button>
            {help ? <p id={helpId} className="help account-help">{help}</p> : null}
          </li>;
        })}</ul>
        <div className="account-save">
          <p id="account-save-help" className="help">{namesValid ? "Renaming does not change the active account." : ACCOUNTS_MESSAGES.emptyName}</p>
          <button type="submit" disabled={!dirty || !namesValid} aria-describedby="account-save-help">Save names</button>
        </div>
      </fieldset>
    </form> : null}
    {pendingSwitch && snapshot && !snapshot.staticOverride ? <SwitchConfirmation target={nameOf(snapshot, pendingSwitch)} onConfirm={confirmSwitch} onCancel={cancelSwitch} /> : null}
  </section>;
}

/** Inline confirmation for an account switch. Cancel is focused first, because the change can reach a running task. */
function SwitchConfirmation({ target, onConfirm, onCancel }: { target: string; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
  }
  return <div className="account-confirm" role="alertdialog" aria-modal="false" aria-labelledby="account-confirm-title" aria-describedby="account-confirm-text" onKeyDown={onKeyDown}>
    <h3 id="account-confirm-title">Switch to {target}?</h3>
    <p id="account-confirm-text">Changing the active Devin account affects subsequent gateway requests, potentially including requests from a Codex task already in progress. Switch accounts between tasks whenever possible.</p>
    <div className="account-confirm-actions">
      <button type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
      <button type="button" onClick={onConfirm}>Switch to {target}</button>
    </div>
  </div>;
}