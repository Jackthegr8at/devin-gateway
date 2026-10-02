import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { initialModelSelection } from "../src/admin/model-selection.ts";
import { getCodexModelProfile } from "../src/admin/codex-model-profiles.ts";
import { PickerApiError, type PickerApi } from "../web/model-picker/api.ts";
import type { AdminModel, ModelSelection } from "../web/model-picker/types.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1:38644/admin/", pretendToBeVisual: true });
const installed = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Node: dom.window.Node,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
  installed.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ModelPicker } = await import("../web/model-picker/ModelPicker.tsx");
let root: ReturnType<typeof createRoot> | undefined;
beforeEach(async () => { if (root) await act(() => root!.unmount()); dom.window.document.body.innerHTML = '<div id="fixture"></div>'; });
afterAll(async () => {
  if (root) await act(() => root!.unmount()); dom.window.close();
  for (const [name, descriptor] of installed) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
});
function model(id: string, displayName = id, available = true): AdminModel {
  const profile = getCodexModelProfile(id) ?? null;
  return { id, displayName, available, enabled: !!profile, ...(id === "swe-2-medium" ? { family: { id: "swe-2", displayName: "SWE-2", effort: "medium", provenance: "reviewed_fallback", upstreamDefaultEffort: null } } : {}), contextWindow: 200_000, maxOutputTokens: 64_000, supportsImages: false,
    upstreamThinking: true, metadataProvenance: { id: "upstream" }, codex: { status: profile ? "validated" : "unvalidated", profile, exportEligible: !!profile && available } };
}
function mockApi(conflict = false) {
  const models = [model("glm-5-3-flash-low", "GLM-5.3 Flash Low"), model("swe-2-medium", "SWE-2 Medium"),
    ...Array.from({ length: 520 }, (_, i) => model(`${i % 3 === 0 ? "swe" : i % 3 === 1 ? "fusion" : "other"}-fixture-${i}`, `Named Alpha ${i}`)),
    model("saved-removed", "Unavailable fixture", false)];
  let selection = initialModelSelection(); let loads = 0;
  const saves: { draft: ModelSelection; etag: string }[] = [];
  const api: PickerApi = {
    async load() { loads++; return { models, selection: structuredClone(selection), etag: `"model-selection-v2-${selection.revision}"` }; },
    async save(draft, etag) {
      saves.push({ draft: structuredClone(draft), etag });
      if (conflict) { selection = { ...initialModelSelection(), revision: 2 }; throw new PickerApiError(412, "Another client changed the selection. Your draft was not saved."); }
      selection = { ...structuredClone(draft), revision: draft.revision + 1 };
      return { selection, etag: `"model-selection-v2-${selection.revision}"` };
    },
  };
  return { api, saves, loads: () => loads };
}
async function mount(api: PickerApi) {
  root = createRoot(document.getElementById("fixture")!);
  await act(async () => { root!.render(<ModelPicker api={api} />); await Promise.resolve(); });
}
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((element) => element.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`); return found;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function search(value: string) {
  const input = document.querySelector('input[type="search"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
function rows() { return [...document.querySelectorAll(".model-row")]; }
async function checkModel(id: string) { await click(document.querySelector(`.model-row[data-model-id="${id}"] input`) as HTMLElement); }

describe("rendered Cody-style model picker", () => {
  test("height-aware default follows viewport changes until explicitly toggled and cleans up its listener", async () => {
    const original = Object.getOwnPropertyDescriptor(dom.window, "matchMedia");
    const listeners = new Set<() => void>();
    const media = { matches: true, addEventListener: (_: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_: string, callback: () => void) => listeners.delete(callback) };
    Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => media });
    try {
      await mount(mockApi().api);
      const toggle = document.querySelector('.configuration-toggle') as HTMLButtonElement;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(() => { media.matches = false; for (const callback of listeners) callback(); });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      await click(toggle);
      await act(() => { media.matches = true; for (const callback of listeners) callback(); });
      await act(() => { media.matches = false; for (const callback of listeners) callback(); });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      await act(() => root!.unmount()); root = undefined;
      expect(listeners.size).toBe(0);
    } finally {
      if (original) Object.defineProperty(dom.window, "matchMedia", original);
      else Reflect.deleteProperty(dom.window, "matchMedia");
    }
  });
  test("configuration collapse retains draft controls and updates the role summary", async () => {
    const base = mockApi();
    await mount(base.api);
    const toggle = document.querySelector('.configuration-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await checkModel("other-fixture-2");
    const select = document.querySelector('select[aria-label="Default / parent model"]') as HTMLSelectElement;
    await act(() => {
      select.value = "swe-2";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    expect(toggle.textContent).toContain("Parent: SWE-2 / medium");
    await click(toggle);
    expect(document.getElementById("configuration-controls")!.hidden).toBe(true);
    expect(document.querySelector('select[aria-label="Default / parent model"]')).toBe(select);
    await click(toggle);
    expect(select.value).toBe("swe-2");
    expect((document.querySelector('.model-row[data-model-id="other-fixture-2"] input') as HTMLInputElement).checked).toBe(true);
    await click(button("Save selection"));
    expect(base.saves[0].draft.roles.default).toEqual({ modelId: "swe-2", effort: "medium" });
    expect(base.saves[0].draft.enabledModels).toContain("other-fixture-2");
  });
  test("category chevron, click-away and keyboard dismissal preserve the multi-select draft", async () => {
    await mount(mockApi().api);
    const details = document.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    expect(summary.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await click(summary);
    expect(details.open).toBe(true);
    const inputs = details.querySelectorAll("input");
    await click(inputs[0]); await click(inputs[1]);
    expect(details.open).toBe(true);
    expect((inputs[0] as HTMLInputElement).checked).toBe(true);
    expect((inputs[1] as HTMLInputElement).checked).toBe(true);
    await act(() => document.querySelector("h1")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
    expect(details.open).toBe(false);
    await click(summary);
    await act(() => inputs[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
    expect((inputs[0] as HTMLInputElement).checked).toBe(true);
    await click(summary);
    await act(() => button("Cancel").focus());
    expect(details.open).toBe(false); // Keyboard focus outside also dismisses without trapping it.
  });
  test("unsorted family rows display only discovered efforts in canonical order", async () => {
    const base = mockApi(); const load = base.api.load;
    base.api.load = async () => {
      const snapshot = await load();
      snapshot.models.unshift(...["max", "xhigh", "high", "low"].map((effort) => ({
        ...model(`swe-order-${effort}`), family: { id: "swe-2", displayName: "SWE-2", effort, provenance: "upstream_family_metadata", upstreamDefaultEffort: "high" },
      })));
      return snapshot;
    };
    await mount(base.api);
    const group = document.querySelector('.model-family[aria-label="SWE-2 variants"]')!;
    expect([...group.querySelectorAll(".model-row")].map((row) => row.getAttribute("data-model-id"))).toEqual([
      "swe-order-low", "swe-2-medium", "swe-order-high", "swe-order-xhigh", "swe-order-max",
    ]);
    expect(group.textContent).not.toContain("off ·");
    expect(group.textContent).not.toContain("minimal ·");
  });
  test("role thinking choices use canonical ordering without adding unreviewed levels", async () => {
    const base = mockApi(); const load = base.api.load;
    base.api.load = async () => {
      const snapshot = await load();
      // Synthetic shared family exercises ordering; the exact two reviewed profiles are unchanged.
      snapshot.models = [snapshot.models[1], snapshot.models[0]].map((row) => ({ ...row,
        family: { id: "synthetic-shared-family", displayName: "Synthetic family", effort: row.codex.profile!.defaultReasoningEffort,
          provenance: "upstream_family_metadata", upstreamDefaultEffort: null },
      }));
      snapshot.selection.roles = { default: { modelId: "synthetic-shared-family", effort: "low" },
        swe_worker: { modelId: "synthetic-shared-family", effort: "medium" } };
      return snapshot;
    };
    await mount(base.api);
    for (const label of ["Default / parent thinking", "swe_worker thinking"]) {
      const select = document.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      expect([...select.options].map((option) => option.value)).toEqual(["low", "medium"]);
    }
  });
  test("family variants group once; only enabled reviewed Medium appears in worker effort choices", async () => {
    const base = mockApi();
    const load = base.api.load;
    base.api.load = async () => {
      const snapshot = await load();
      snapshot.models.splice(2, 0, { ...model("swe-2-high", "SWE-2 High"), family: { id: "swe-2", displayName: "SWE-2", effort: "high", provenance: "upstream_family_metadata", upstreamDefaultEffort: "high" } },
        { ...model("swe-2-max", "SWE-2 Max", false), family: { id: "swe-2", displayName: "SWE-2", effort: "max", provenance: "reviewed_fallback", upstreamDefaultEffort: "high" } });
      snapshot.selection.enabledModels.push("swe-2-high", "swe-2-max");
      return snapshot;
    };
    await mount(base.api);
    expect(document.querySelectorAll('.model-family[aria-label="SWE-2 variants"]')).toHaveLength(1);
    expect(document.querySelector('.model-row[data-model-id="swe-2-high"]')?.textContent).toContain("Metadata not validated");
    expect(document.querySelector('.model-row[data-model-id="swe-2-max"]')?.textContent).toContain("Unavailable");
    const effort = document.querySelector('select[aria-label="swe_worker thinking"]') as HTMLSelectElement;
    expect([...effort.options].map((option) => option.value)).toEqual(["medium"]);
    expect(effort.value).toBe("medium");
    await checkModel("swe-2-medium");
    expect(button("Save selection").disabled).toBe(true);
    expect(effort.value).toBe("medium"); // No substitution to discovered upstream High.
  });
  test("500+ models render only 60 rows with labelled native controls and pagination", async () => {
    await mount(mockApi().api);
    expect(rows()).toHaveLength(60); expect(document.querySelector("h1")?.textContent).toBe("Devin models");
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('select[aria-label="swe_worker model"]')?.getAttribute("aria-invalid")).toBe("false");
    await click(button("Next")); expect(rows()).toHaveLength(60); expect(document.querySelector(".pagination")?.textContent).toContain("Page 2 of 9");
    expect((document.querySelector('input[type="search"]') as HTMLInputElement).labels?.length).toBe(1);
  });
  test("name/ID search is case-insensitive and category union uses display buckets", async () => {
    await mount(mockApi().api); await search("ALPHA 101"); expect(rows()).toHaveLength(1);
    await search("SWE-2-MEDIUM"); expect(rows()[0].getAttribute("data-model-id")).toBe("swe-2-medium");
    await search("");
    const categoryInputs = document.querySelectorAll(".category-menu input");
    await click(categoryInputs[0] as HTMLElement); await click(categoryInputs[1] as HTMLElement);
    expect(rows().every((row) => /^(swe|fusion)/.test(row.getAttribute("data-model-id")!))).toBe(true);
  });
  test("checkbox changes are draft-only and enabled-only immediately uses that draft", async () => {
    const mock = mockApi(); await mount(mock.api); await checkModel("other-fixture-2");
    expect(mock.saves).toHaveLength(0); await click(document.querySelector(".enabled-only input") as HTMLElement);
    expect(rows()).toHaveLength(3); expect(rows().some((row) => row.getAttribute("data-model-id") === "other-fixture-2")).toBe(true);
  });
  test("filtered bulk enable and disable cover all matches, including later pages", async () => {
    const mock = mockApi(); await mount(mock.api); await search("fixture");
    await click(button("Enable these 521")); expect(mock.saves).toHaveLength(0);
    await click(button("Save selection")); expect(mock.saves[0].draft.enabledModels).toHaveLength(523);
    expect(mock.saves[0].draft.enabledModels).toContain("swe-fixture-519");
    await click(button("Disable these 521")); await click(button("Save selection"));
    expect(mock.saves[1].draft.enabledModels).toEqual(["glm-5-3-flash-low", "swe-2-medium"]);
  });
  test("Save sends one coherent selection and its original ETag", async () => {
    const mock = mockApi(); await mount(mock.api); await checkModel("other-fixture-2"); await click(button("Save selection"));
    expect(mock.saves).toHaveLength(1); expect(mock.saves[0].etag).toBe('"model-selection-v2-1"');
    expect(mock.saves[0].draft.roles.swe_worker).toEqual({ modelId: "swe-2", effort: "medium" }); expect(document.querySelector('[role="status"]')?.textContent).toContain("Revision 2");
    expect(button("Save selection").disabled).toBe(true);
  });
  test("Cancel discards roles, selections, future choice and filters without any PUT", async () => {
    const mock = mockApi(); await mount(mock.api); await click(button("Enable all"));
    await click(document.querySelector(".future-control input") as HTMLElement);
    const role = document.querySelector('select[aria-label="swe_worker model"]') as HTMLSelectElement;
    await act(() => { role.value = "glm-5-3-flash-low"; role.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await search("ALPHA"); await click(button("Cancel"));
    expect(mock.saves).toHaveLength(0); expect((document.querySelector(".future-control input") as HTMLInputElement).checked).toBe(false);
    expect(role.value).toBe("swe-2"); expect((document.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("");
    expect((document.querySelector('.model-row[data-model-id="other-fixture-2"] input') as HTMLInputElement).checked).toBe(false);
  });
  test("412 keeps the draft, blocks overwrite and offers explicit latest-state reload", async () => {
    const mock = mockApi(true); await mount(mock.api); await checkModel("other-fixture-2"); await click(button("Save selection"));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Your draft was not saved");
    expect((document.querySelector('.model-row[data-model-id="other-fixture-2"] input') as HTMLInputElement).checked).toBe(true);
    expect(button("Save selection").disabled).toBe(true); expect(mock.saves).toHaveLength(1);
    await click(button("Reload latest (discard draft)")); expect(mock.loads()).toBe(2);
    expect((document.querySelector('.model-row[data-model-id="other-fixture-2"] input') as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector(".picker-footer")?.textContent).toContain("Saved revision 2");
  });
  test("disabling assigned model cannot silently change role or save", async () => {
    const mock = mockApi(); await mount(mock.api); await checkModel("swe-2-medium");
    expect((document.querySelector('select[aria-label="swe_worker model"]') as HTMLSelectElement).value).toBe("swe-2");
    expect(document.querySelector(".validation")?.textContent).toContain("re-enable"); expect(button("Save selection").disabled).toBe(true);
    await checkModel("swe-2-medium"); expect(document.querySelector(".validation")).toBeNull(); expect(mock.saves).toHaveLength(0);
  });
  test("unvalidated models remain visible/enablable; unavailable rows are explicit and not role options", async () => {
    const mock = mockApi(); await mount(mock.api); await checkModel("other-fixture-2");
    expect(document.querySelector('.model-row[data-model-id="other-fixture-2"]')?.textContent).toContain("Metadata not validated");
    expect([...document.querySelectorAll('select[aria-label="swe_worker model"] option')].map((option) => option.getAttribute("value"))).toEqual(["glm-5-3-flash-low", "swe-2"]);
    await search("saved-removed"); expect(rows()[0].textContent).toContain("Unavailable"); await checkModel("saved-removed");
    expect(button("Save selection").disabled).toBe(false);
  });
  test("future toggle is disabled for partial selection and individual disable exits future mode", async () => {
    await mount(mockApi().api); const future = document.querySelector(".future-control input") as HTMLInputElement;
    expect(future.disabled).toBe(true); await click(button("Enable all")); expect(future.disabled).toBe(false);
    await click(future); expect(future.checked).toBe(true); await checkModel("other-fixture-2");
    expect(future.checked).toBe(false); expect(future.disabled).toBe(true); expect(document.querySelector("#future-help")?.textContent).toContain("Partial selections save exact IDs");
  });
  test("Escape cancels draft and restores focus; category Escape closes menu first", async () => {
    await mount(mockApi().api); await checkModel("other-fixture-2");
    const details = document.querySelector("details")!; details.open = true;
    await act(() => details.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(details.open).toBe(false); expect(button("Save selection").disabled).toBe(false);
    await act(() => document.querySelector("main")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(button("Save selection").disabled).toBe(true); expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));
  });
});
