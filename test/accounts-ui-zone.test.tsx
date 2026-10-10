import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { AccountsApi, AccountsSnapshot, AccountsUpdate } from "../web/model-picker/accounts.ts";
import { AccountsApiError } from "../web/model-picker/accounts.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:38644/admin/", pretendToBeVisual: true });
const installed = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
  installed.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AccountsZone } = await import("../web/model-picker/AccountsZone.tsx");
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => { dom.window.document.body.innerHTML = '<div id="fixture"></div>'; });
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; });
afterAll(() => {
  dom.window.close();
  for (const [name, descriptor] of installed) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
});

const etag = (revision: number) => `"accounts-v1-${revision}"`;
function snapshot(overrides: Partial<AccountsSnapshot> = {}, revision = 3): AccountsSnapshot {
  return {
    revision, etag: etag(revision), activeProfileId: "personal", staticOverride: false,
    profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "unconfigured" },
    ],
    ...overrides,
  };
}
interface Fake { api: AccountsApi; saves: { update: AccountsUpdate; etag: string }[]; loads: () => number; resolveSave(value: AccountsSnapshot): void; rejectSave(error: unknown): void }
function fakeApi(initial: AccountsSnapshot, options: { save?: (update: AccountsUpdate, etag: string) => Promise<AccountsSnapshot>; load?: () => Promise<AccountsSnapshot> } = {}): Fake {
  let current = initial; let loads = 0;
  const saves: Fake["saves"] = [];
  let resolve: (value: AccountsSnapshot) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const api: AccountsApi = {
    async load() { loads++; return options.load ? options.load() : structuredClone(current); },
    async save(update, tag) {
      saves.push({ update: structuredClone(update), etag: tag });
      if (options.save) return options.save(update, tag);
      return new Promise<AccountsSnapshot>((ok, fail) => { resolve = ok; reject = fail; });
    },
  };
  return { api, saves, loads: () => loads, resolveSave: (value) => resolve(value), rejectSave: (error) => reject(error) };
}
async function mount(api: AccountsApi, wrapper?: (children: unknown) => unknown) {
  root = createRoot(document.getElementById("fixture")!);
  const element = <AccountsZone api={api} />;
  await act(async () => { root!.render(wrapper ? wrapper(element) as never : element); await Promise.resolve(); });
}
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
function buttonNamed(text: string) {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
function row(id: string) {
  const found = document.querySelector<HTMLElement>(`li[data-profile-id="${id}"]`);
  if (!found) throw new Error(`Missing row: ${id}`);
  return found;
}
function nameInput(id: string) { return row(id).querySelector("input") as HTMLInputElement; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function typeInto(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
function status() { return document.querySelector('[role="status"]')?.textContent ?? ""; }
function alertText() { return document.querySelector('[role="alert"]')?.textContent ?? ""; }
function saveNamesButton() { return buttonNamed("Save names") as HTMLButtonElement; }

/** Confirms the pending switch in the inline dialog. Each switch needs this explicit step. */
function confirmSwitch(): HTMLElement { return [...document.querySelectorAll(".account-confirm button")].find((b) => b.textContent?.startsWith("Switch to")) as HTMLElement; }
describe("AccountsZone", () => {
  test("shows the Accounts section, the active marker, and each credential state with text labels", async () => {
    await mount(fakeApi(snapshot()).api);
    await flush();
    expect(document.querySelector("h2")?.textContent).toBe("Accounts");
    expect(document.querySelector(".account-row")).toBeTruthy();
    expect(row("personal").classList.contains("is-active")).toBe(true);
    expect(row("personal").querySelector(".active-marker")?.textContent).toBe("Active");
    expect(row("personal").textContent).toContain("Signed in");
    expect(row("team").querySelector(".active-marker")).toBeNull();
    expect(row("team").textContent).toContain("Not signed in");
    expect(document.body.textContent).toContain("affects subsequent gateway requests, potentially including requests from a Codex task already in progress");
    expect(document.getElementById("accounts-warning")?.textContent).toContain("Requests that send their own Authorization or x-api-key header use that credential, not the selected account.");
  });

  test("labels each name input and shows the Needs re-enrollment state for invalid credentials", async () => {
    await mount(fakeApi(snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "invalid" },
      { id: "team", name: "Team", credentialState: "configured" },
    ], activeProfileId: "team" })).api);
    await flush();
    const personal = nameInput("personal");
    expect(document.querySelector(`label[for="${personal.id}"]`)?.textContent).toBe("Name for Personal");
    expect(nameInput("team").value).toBe("Team");
    expect(row("personal").textContent).toContain("Needs re-enrollment");
    expect(row("personal").textContent).toContain("Sign in again from the server terminal first.");
  });

  test("disables the use button for an unconfigured profile and explains how to sign in, without printing a command", async () => {
    await mount(fakeApi(snapshot()).api);
    await flush();
    const useTeam = row("team").querySelector("button") as HTMLButtonElement;
    expect(useTeam.textContent).toBe("Use Team");
    expect(useTeam.disabled).toBe(true);
    expect(row("team").querySelector("p.help")?.textContent).toBe("Sign in from the server terminal first.");
    expect(useTeam.getAttribute("aria-describedby")).toBe("account-help-team");
    expect(document.body.textContent).not.toMatch(/devin-gateway-login|node |bun |\.json|token/i);
  });

  test("the active profile has no use button, and a configured inactive profile can be activated", async () => {
    await mount(fakeApi(snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] })).api);
    await flush();
    expect((row("personal").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect((row("team").querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });

  test("activating a profile sends PUT with the new active ID and saved names, then announces the change", async () => {
    const configured = snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] });
    const fake = fakeApi(configured, { save: async (update) => ({
      revision: 4, etag: etag(4), activeProfileId: update.activeProfileId, staticOverride: false,
      profiles: update.profiles.map((profile) => ({ ...profile, credentialState: profile.id === "personal" ? "configured" : "configured" })),
    }) });
    await mount(fake.api);
    await flush();
    await click(row("team").querySelector("button") as HTMLElement);
    await click(confirmSwitch());
    await flush();
    expect(fake.saves).toHaveLength(1);
    expect(fake.saves[0].etag).toBe(etag(3));
    expect(fake.saves[0].update).toEqual({ activeProfileId: "team", profiles: [{ id: "personal", name: "Personal" }, { id: "team", name: "Team" }] });
    expect(status()).toBe("Active account is now Team. New requests use this account.");
    expect(document.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(row("team").classList.contains("is-active")).toBe(true);
    expect(row("personal").querySelector(".active-marker")).toBeNull();
  });

  test("controls are disabled while a request is in flight, which prevents a double submit", async () => {
    const configured = snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] });
    const fake = fakeApi(configured);
    await mount(fake.api);
    await flush();
    await click(row("team").querySelector("button") as HTMLElement);
    await click(confirmSwitch());
    expect((document.querySelector(".account-controls") as HTMLFieldSetElement).disabled).toBe(true);
    expect(nameInput("team").matches(":disabled")).toBe(true);
    expect((row("personal").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(fake.saves).toHaveLength(1);
    await act(async () => fake.resolveSave({ ...configured, activeProfileId: "team", etag: etag(4), revision: 4 }));
    await flush();
    expect((document.querySelector(".account-controls") as HTMLFieldSetElement).disabled).toBe(false);
  });

  test("a Use click only opens the confirmation and sends nothing until Confirm", async () => {
    const configured = snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] });
    const fake = fakeApi(configured);
    await mount(fake.api);
    await flush();
    await click(row("team").querySelector("button") as HTMLElement);
    expect(document.querySelector(".account-confirm")).toBeTruthy();
    expect(document.querySelector(".account-confirm")?.getAttribute("role")).toBe("alertdialog");
    expect(document.body.textContent).toContain("affects subsequent gateway requests, potentially including requests from a Codex task already in progress");
    expect(fake.saves).toHaveLength(0);
  });

  test("Cancel and Escape close the confirmation without sending a switch", async () => {
    const configured = snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] });
    const fake = fakeApi(configured);
    await mount(fake.api);
    await flush();
    await click(row("team").querySelector("button") as HTMLElement);
    const cancel = [...document.querySelectorAll(".account-confirm button")].find((b) => b.textContent === "Cancel") as HTMLElement;
    await click(cancel);
    await flush();
    expect(document.querySelector(".account-confirm")).toBeNull();
    expect(fake.saves).toHaveLength(0);
    await click(row("team").querySelector("button") as HTMLElement);
    await act(async () => { document.querySelector(".account-confirm")!.dispatchEvent(new (document.defaultView!.KeyboardEvent)("keydown", { key: "Escape", bubbles: true })); });
    await flush();
    expect(document.querySelector(".account-confirm")).toBeNull();
    expect(fake.saves).toHaveLength(0);
  });
  test("a 409 account_unconfigured error keeps the active account and shows the message in an alert", async () => {
    const configuredTeam = snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] });
    await mount(fakeApi(configuredTeam, { save: async () => { throw new AccountsApiError(409, "account_unconfigured", "Team is not signed in."); } }).api);
    await flush();
    await click(row("team").querySelector("button") as HTMLElement);
    await click(confirmSwitch());
    await flush();
    expect(alertText()).toBe("Team is not signed in.");
    expect(row("personal").classList.contains("is-active")).toBe(true);
    expect(row("team").classList.contains("is-active")).toBe(false);
    expect(status()).toBe("");
  });

  test("a 412 conflict reloads the latest accounts, replaces unsaved names, and tells the user", async () => {
    const latest = snapshot({ revision: 9, etag: etag(9), activeProfileId: "team", profiles: [
      { id: "personal", name: "Personal (from elsewhere)", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] }, 9);
    const fake = fakeApi(snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] }), {
      save: async () => { throw new AccountsApiError(412, "revision_conflict", "Accounts changed somewhere else. The latest settings are loaded. Review them before you try again."); },
      load: async () => latest,
    });
    await mount(fake.api);
    await flush();
    await typeInto(nameInput("personal"), "My unsaved edit");
    await click(saveNamesButton());
    await flush();
    expect(alertText()).toContain("Accounts changed somewhere else");
    expect(fake.loads()).toBe(2);
    expect(nameInput("personal").value).toBe("Personal (from elsewhere)");
    expect(row("team").classList.contains("is-active")).toBe(true);
  });

  test("Save names is disabled until a name changes, and sends both names with the current active ID", async () => {
    const fake = fakeApi(snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "unconfigured" },
    ] }), { save: async (update) => ({ revision: 4, etag: etag(4), activeProfileId: update.activeProfileId, staticOverride: false, profiles: update.profiles.map((profile) => ({ ...profile, credentialState: profile.id === "personal" ? "configured" : "unconfigured" })) }) });
    await mount(fake.api);
    await flush();
    expect(saveNamesButton().disabled).toBe(true);
    await typeInto(nameInput("team"), "Work");
    expect(saveNamesButton().disabled).toBe(false);
    await click(saveNamesButton());
    await flush();
    expect(fake.saves[0].update).toEqual({ activeProfileId: "personal", profiles: [{ id: "personal", name: "Personal" }, { id: "team", name: "Work" }] });
    expect(fake.saves[0].etag).toBe(etag(3));
    expect(status()).toBe("Account names saved.");
    expect(saveNamesButton().disabled).toBe(true);
  });

  test("an empty name disables Save names and marks the field invalid", async () => {
    await mount(fakeApi(snapshot()).api);
    await flush();
    await typeInto(nameInput("team"), "   ");
    expect(saveNamesButton().disabled).toBe(true);
    expect(nameInput("team").getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain("Each account needs a name before you save.");
  });

  test("a failed load shows an alert and a retry button, and retry loads again", async () => {
    let attempts = 0;
    const api: AccountsApi = {
      async load() { attempts++; if (attempts === 1) throw new AccountsApiError(503, "accounts_unavailable", "Accounts are unavailable right now. Try again shortly."); return snapshot(); },
      async save() { throw new Error("unused"); },
    };
    await mount(api);
    await flush();
    expect(alertText()).toContain("Accounts are unavailable right now.");
    expect(document.querySelector(".account-controls")).toBeNull();
    await click(buttonNamed("Retry loading accounts"));
    await flush();
    expect(attempts).toBe(2);
    expect(row("personal").classList.contains("is-active")).toBe(true);
  });

  test("Escape inside the section does not bubble to the parent picker", async () => {
    const parentKeys: string[] = [];
    await mount(fakeApi(snapshot()).api, (children) => <div onKeyDown={(event: { key: string }) => parentKeys.push(event.key)}>{children as never}</div>);
    await flush();
    await act(() => nameInput("team").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(parentKeys).toEqual([]);
  });

  test("never renders token-like or credential text when the API returns only the allowlisted fields", async () => {
    await mount(fakeApi(snapshot()).api);
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/token|secret|apiKey|refresh|bearer|password/i);
  });
});
describe("AccountsZone with a static Devin key", () => {
  const NOTICE = "A static Devin key is set on this gateway. Requests use that key, not the selected account, and switching is disabled until it is removed.";
  const configuredPair = (overrides: Partial<AccountsSnapshot> = {}) => snapshot({ staticOverride: true, profiles: [
    { id: "personal", name: "Personal", credentialState: "configured" },
    { id: "team", name: "Team", credentialState: "configured" },
  ], ...overrides });
  function noticeRegion() { return document.querySelector<HTMLElement>('.account-notice-region[role="status"]'); }

  test("shows the notice in a status region and disables every Use button with a text reason", async () => {
    await mount(fakeApi(configuredPair()).api);
    await flush();
    const region = noticeRegion();
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe(NOTICE);
    for (const id of ["personal", "team"]) {
      const use = row(id).querySelector("button") as HTMLButtonElement;
      expect(use.disabled).toBe(true);
      const helpId = use.getAttribute("aria-describedby");
      expect(helpId).toBeTruthy();
      expect(document.getElementById(helpId!)?.textContent).toContain("Switching is disabled while a static Devin key is set on this gateway.");
    }
  });

  test("a Use click on a configured inactive account opens no confirmation and sends nothing", async () => {
    const fake = fakeApi(configuredPair());
    await mount(fake.api);
    await flush();
    await click(row("team").querySelector("button") as HTMLElement);
    expect(document.querySelector(".account-confirm")).toBeNull();
    expect(fake.saves).toHaveLength(0);
  });

  test("Save names still sends the saved active account and the new names", async () => {
    const fake = fakeApi(configuredPair(), { save: async (update) => ({
      revision: 4, etag: etag(4), activeProfileId: update.activeProfileId, staticOverride: true,
      profiles: update.profiles.map((profile) => ({ ...profile, credentialState: "configured" as const })),
    }) });
    await mount(fake.api);
    await flush();
    await typeInto(nameInput("team"), "Work");
    expect(saveNamesButton().disabled).toBe(false);
    await click(saveNamesButton());
    await flush();
    expect(fake.saves).toHaveLength(1);
    expect(fake.saves[0].update).toEqual({ activeProfileId: "personal", profiles: [{ id: "personal", name: "Personal" }, { id: "team", name: "Work" }] });
    expect(status()).toBe("Account names saved.");
    expect(noticeRegion()?.textContent).toBe(NOTICE);
    expect((row("team").querySelector("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a reload that reports a static key drops an open switch, and a later reload does not bring it back", async () => {
    let loads = 0;
    const normal = snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] });
    const api: AccountsApi = {
      async load() {
        loads++;
        if (loads === 2) throw new AccountsApiError(503, "accounts_unavailable", "Accounts are unavailable right now. Try again shortly.");
        if (loads === 3) return configuredPair();
        return structuredClone(normal);
      },
      async save() { throw new AccountsApiError(412, "revision_conflict", "Accounts changed somewhere else. The latest settings are loaded. Review them before you try again."); },
    };
    await mount(api);
    await flush();
    await typeInto(nameInput("personal"), "Edited");
    await click(saveNamesButton());
    await flush();
    expect(buttonNamed("Retry loading accounts")).toBeTruthy();
    await click(row("team").querySelector("button") as HTMLElement);
    expect(document.querySelector(".account-confirm")).toBeTruthy();
    await click(buttonNamed("Retry loading accounts"));
    await flush();
    expect(document.querySelector(".account-confirm")).toBeNull();
    expect(noticeRegion()?.textContent).toBe(NOTICE);
    await typeInto(nameInput("team"), "Work");
    await click(saveNamesButton());
    await flush();
    expect(alertText()).toContain("Accounts changed somewhere else");
    expect(noticeRegion()?.textContent).toBe("");
    expect(document.querySelector(".account-confirm")).toBeNull();
    expect((row("team").querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });
  test("a snapshot with staticOverride false shows no notice and keeps the configured Use button enabled", async () => {
    await mount(fakeApi(snapshot({ profiles: [
      { id: "personal", name: "Personal", credentialState: "configured" },
      { id: "team", name: "Team", credentialState: "configured" },
    ] })).api);
    await flush();
    expect(document.querySelector(".account-notice")).toBeNull();
    expect(noticeRegion()?.textContent).toBe("");
    expect(document.body.textContent).not.toContain("A static Devin key is set");
    expect((row("team").querySelector("button") as HTMLButtonElement).disabled).toBe(false);
  });
});describe("ModelPicker mount point", () => {
  const modelFake = () => ({
    async load() {
      const { initialModelSelection } = await import("../src/admin/model-selection.ts");
      return { models: [], selection: initialModelSelection(), etag: '"model-selection-v2-1"' };
    },
    async save() { throw new Error("unused"); },
  });
  test("renders the Accounts section only when an accounts client is passed, and the model picker still loads", async () => {
    const { ModelPicker } = await import("../web/model-picker/ModelPicker.tsx");
    const without = document.getElementById("fixture")!;
    root = createRoot(without);
    await act(async () => { root!.render(<ModelPicker api={modelFake() as never} />); await Promise.resolve(); });
    await flush();
    expect(document.querySelector("section.accounts")).toBeNull();
    expect(document.querySelector("#fixture")?.innerHTML.length ?? 0).toBeGreaterThan(0);
    await act(async () => root!.unmount());
    root = undefined;

    dom.window.document.body.innerHTML = '<div id="fixture"></div>';
    root = createRoot(document.getElementById("fixture")!);
    await act(async () => { root!.render(<ModelPicker api={modelFake() as never} accountsApi={fakeApi(snapshot()).api} />); await Promise.resolve(); });
    await flush();
    expect(document.querySelectorAll("section.accounts")).toHaveLength(1);
    expect(document.querySelector("section.accounts h2")?.textContent).toBe("Accounts");
    expect(row("personal").classList.contains("is-active")).toBe(true);
    expect(document.querySelector("#fixture")?.innerHTML.length ?? 0).toBeGreaterThan(0);
  });
});
