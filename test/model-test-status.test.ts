import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelTestStatusStore, ModelValidationTracker, effectiveTestStatus, testStatusETag, returnedToolSucceeded, validateTestStatus } from "../src/admin/model-test-status.ts";
import { ModelSelectionStore } from "../src/admin/model-selection-store.ts";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";

async function fixture(run: (store: ModelTestStatusStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "synthetic-model-status-"));
  try { const store = new ModelTestStatusStore(root); await store.initialize(); await run(store, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test("test status is empty, private, atomic and restart-persistent; selection bytes and revision stay unchanged", async () => fixture(async (store, root) => {
  const selection = new ModelSelectionStore(root); await selection.initialize(); const before = await readFile(selection.file);
  expect(await store.read()).toEqual({ schemaVersion: 1, revision: 1, variants: {} });
  const next = await store.markManual("swe-2-high", "tested", testStatusETag(await store.read()));
  expect(next.revision).toBe(2); expect(effectiveTestStatus(next, "swe-2-high")).toMatchObject({ status: "tested", source: "manual" });
  await expect(store.markManual("swe-2-high", "untested", '"model-test-status-v1-1"')).rejects.toThrow();
  const restart = new ModelTestStatusStore(root); await restart.initialize(); expect(await restart.read()).toEqual(next);
  await restart.markManual("swe-2-high", "untested", testStatusETag(next));
  await restart.markAutomatic("swe-2-high", "swe-2", "high");
  expect(effectiveTestStatus(await restart.read(), "swe-2-high")).toMatchObject({ status: "untested", source: "manual" });
  expect((await restart.read()).variants["swe-2-high"].automatic).toMatchObject({ logicalModel: "swe-2", effort: "high" });
  expect(await readFile(selection.file)).toEqual(before);
  expect((await readdir(root)).some(p => p.endsWith(".tmp") || p.endsWith(".lock"))).toBe(false);
  if (process.platform !== "win32") { expect((await stat(root)).mode & 0o777).toBe(0o700); expect((await stat(store.file)).mode & 0o777).toBe(0o600); }
  await writeFile(store.file, '{"schemaVersion":1,"variants":"corrupt"}');
  await expect(restart.initialize()).rejects.toThrow();
}));

test("only explicit terminal tool success qualifies; no opaque output or failed/running command", () => {
  for (const value of ['Exit code: 0\nOutput:\nsynthetic-result', 'Process exited with code 0\n', '{"exit_code":0}', { status: "success" }]) expect(returnedToolSucceeded(value)).toBe(true);
  for (const value of ['synthetic-result', 'Exit code: 1\n', 'Exit code: 0\nExit code: 1', 'Process running with session ID 123', { exit_code: 1, status: "success" }, { exit_code: 0, error: "synthetic" }, { exit_code: 0, session_id: 123 }, { status: "completed" }]) expect(returnedToolSucceeded(value)).toBe(false);
  expect(() => validateTestStatus({ schemaVersion: 1, revision: 1, variants: { "synthetic": { manual: { status: "tested", updatedAt: "not-a-date" } } } })).toThrow();
});

test("concurrent writers preserve variants; corrupt status never reseeds", async () => fixture(async (store, root) => {
  await Promise.all([store.markAutomatic("swe-2-medium", "swe-2", "medium"), new ModelTestStatusStore(root).markAutomatic("swe-2-high", "swe-2", "high")]);
  expect(Object.keys((await store.read()).variants).sort()).toEqual(["swe-2-high", "swe-2-medium"]);
  expect((await store.read()).revision).toBe(3);
  expect(returnedToolSucceeded("Exit code: 1\nOutput:\nExit code: 0")).toBe(false);
  expect(returnedToolSucceeded("Exit code: 0\nOutput:\nExit code: 1")).toBe(true);
  await writeFile(store.file, "synthetic-corrupt-data"); await expect(store.initialize()).rejects.toThrow();
  expect(await readFile(store.file, "utf8")).toBe("synthetic-corrupt-data");
}));

test("native agent results do not invent success and agent identities cannot satisfy tool call identities", async () => fixture(async store => {
  const agentId = "00000000-0000-4000-8000-000000000001";
  const tracker = new ModelValidationTracker(store);
  function observe(call?: { id: string; name: string }, returned?: { id: string; output: unknown }) {
    let outcomes: unknown;
    const d = new ResponsesSafeDiagnostic("synthetic-agent", Date.now(), undefined, (r, e) => {
      tracker.observe("synthetic-scope", r, e); outcomes = r.correlation_results;
    }, false);
    d.recordResolvedRouting({ logicalModel: "swe-2", requestedEffort: "high", resolvedModelId: "swe-2-high" });
    d.recordUpstreamResponse(200, true); d.recordUpstreamComplete();
    if (call) d.recordNormalizedEmittedToolCall(call);
    if (returned) d.recordNormalizedFunctionCallOutput({ role: "tool", tool_call_id: returned.id, content: JSON.stringify(returned.output) }, returnedToolSucceeded(returned.output));
    d.recordSuccessfulCompletion(); d.finalize(); return outcomes;
  }
  for (const output of [
    { agent_id: agentId, nickname: "Synthetic" },
    { submission_id: "synthetic-submission" },
    { status: {}, timed_out: true },
    { status: { [agentId]: { completed: "Synthetic child result" } }, timed_out: false },
    { status: "running" }, { previous_status: "shutdown" },
  ]) expect(returnedToolSucceeded(output)).toBe(false);
  observe({ id: "synthetic-spawn-call", name: "multi_agent_v1__spawn_agent" });
  expect(observe(undefined, { id: agentId, output: { status: "success" } })).toEqual({ no_issued_call: 1 });
  expect(observe({ id: "synthetic-wait-call", name: "multi_agent_v1__wait_agent" }, { id: "synthetic-spawn-call", output: { agent_id: agentId } })).toEqual({ tool_result_not_successful: 1, issued_call_recorded: 1 });
  expect(observe(undefined, { id: "synthetic-spawn-call", output: { status: "success" } })).toEqual({ no_issued_call: 1 });
  expect(observe(undefined, { id: "synthetic-wait-call", output: { status: { [agentId]: { completed: "Synthetic" } }, timed_out: false } })).toEqual({ tool_result_not_successful: 1 });
  await tracker.drain(); expect((await store.read()).variants).toEqual({});
  // Existing policy is generic, not tool-name-specific: only an explicit successful
  // envelope could qualify. This is a policy boundary, not a native agent fixture.
  observe({ id: "synthetic-generic-call", name: "multi_agent_v1__send_input" });
  expect(observe(undefined, { id: "synthetic-generic-call", output: { status: "success" } })).toEqual({ matched_success: 1 });
  await tracker.drain(); expect((await store.read()).variants["swe-2-high"].automatic).toBeDefined();
}));

test("correlated completed tool round-trip promotes; text/history/failures/wrong credential or effort/replay do not", async () => fixture(async store => {
  let now = 1000; const tracker = new ModelValidationTracker(store, () => now);
  const outcomes: Array<Record<string, number>> = [];
  function finish({ call, returned, failed, scope = "synthetic-credential-hash", effort = "high", model = "swe-2-high" }: { call?: string; returned?: string; failed?: boolean; scope?: string; effort?: string; model?: string }) {
    const d = new ResponsesSafeDiagnostic("synthetic", Date.now(), undefined, (r, e) => { tracker.observe(scope, r, e); outcomes.push({ ...r.correlation_results }); }, false);
    d.addSensitiveValues([`Synthetic Desktop history: swe-2 swe-2-high swe-2-max new-call history-call ${call ?? ""} ${returned ?? ""}`]);
    d.recordResolvedRouting({ logicalModel: "swe-2", requestedEffort: effort, resolvedModelId: model }); d.recordUpstreamResponse(200, true); d.recordUpstreamComplete();
    // History deliberately does not become emitted-call evidence.
    d.recordToolCall("exec_command", "history-call");
    if (call) d.recordNormalizedEmittedToolCall({ name: "exec_command", id: call });
    if (returned) d.recordNormalizedFunctionCallOutput({ role: "tool", tool_call_id: returned, content: "Synthetic private output" }, true);
    if (failed) d.recordFailure({ source: "synthetic", classification: "devin_upstream_model_provider_unavailable" }); else d.recordSuccessfulCompletion();
    d.finalize();
    return outcomes.at(-1);
  }
  finish({}); finish({ returned: "history-call" }); await tracker.drain(); expect((await store.read()).variants).toEqual({});
  expect(finish({ call: "new-call" })).toEqual({ issued_call_recorded: 1 });
  expect(finish({ returned: "new-call", scope: "another-credential" })).toEqual({ scope_mismatch: 1 });
  expect(finish({ returned: "new-call", effort: "max" })).toEqual({ effort_mismatch: 1 });
  expect(finish({ returned: "new-call", model: "swe-2-max" })).toEqual({ model_mismatch: 1 });
  expect(finish({ returned: "unrelated-call" })).toEqual({ no_issued_call: 1 });
  expect(finish({ returned: "new-call", failed: true })).toEqual({ request_ineligible: 1 }); await tracker.drain(); expect((await store.read()).variants).toEqual({});
  finish({ returned: "new-call" }); await tracker.drain(); const saved = await store.read();
  expect(effectiveTestStatus(saved, "swe-2-high")).toMatchObject({ status: "tested", source: "automatic" });
  finish({ returned: "new-call" }); finish({ failed: true }); await tracker.drain(); expect(await store.read()).toEqual(saved);
  finish({ call: "expired-call" }); now += 3600001; finish({ returned: "expired-call" }); await tracker.drain(); expect(await store.read()).toEqual(saved);
  await store.markManual("swe-2-high", "untested", testStatusETag(saved));
  finish({ call: "manual-call" }); finish({ returned: "manual-call" }); await tracker.drain();
  expect(effectiveTestStatus(await store.read(), "swe-2-high")).toMatchObject({ status: "untested", source: "manual" });
}));

test("only normalized structured fields retain history-mentioned IDs; credential overlap and arbitrary text remain redacted", async () => fixture(async (_store, root) => {
  const path = join(root, "structured-safe.jsonl"); const d = new ResponsesSafeDiagnostic("synthetic-structured", Date.now(), path);
  const privateText = "Synthetic Desktop history mentions swe-2 swe-2-max synthetic-issued-call private-looking-id";
  const credential = "synthetic-sensitive-value-4917";
  d.addCredentialValues([credential, `Bearer ${credential}`, "synthetic-cookie-value-9251"]);
  d.addSensitiveValues([privateText, "private-looking-id"]);
  d.recordRouting("private-looking-id", "max", "private-looking-id");
  d.recordEmittedToolCall("exec_command", "private-looking-id");
  d.recordFunctionCallOutput("private-looking-id", true);
  d.recordResolvedRouting({ logicalModel: "swe-2", requestedEffort: "max", resolvedModelId: "swe-2-max" });
  d.recordNormalizedEmittedToolCall({ name: "exec_command", id: "synthetic-issued-call" });
  d.recordNormalizedFunctionCallOutput({ role: "tool", tool_call_id: "synthetic-issued-call", content: privateText }, true);
  d.recordNormalizedFunctionCallOutput({ role: "user", tool_call_id: "arbitrary-user-id", content: privateText }, true);
  d.recordNormalizedEmittedToolCall({ name: "exec_command", id: " arbitrary text " });
  d.recordResolvedRouting({ logicalModel: credential, requestedEffort: "max", resolvedModelId: "swe-2-max" });
  d.recordNormalizedEmittedToolCall({ name: "exec_command", id: credential });
  d.recordNormalizedFunctionCallOutput({ role: "tool", tool_call_id: credential, content: privateText }, true);
  d.recordSuccessfulCompletion(); d.finalize(); const json = await readFile(path, "utf8"); const r = JSON.parse(json);
  expect(r).toMatchObject({ logical_model: "swe-2", requested_effort: "max", resolved_model_id: "swe-2-max", had_tool_call: true, had_function_call_output: true });
  expect(r.tool_calls).toEqual([{ name: "exec_command" }]);
  for (const raw of [privateText, credential, "private-looking-id", "arbitrary-user-id", "arbitrary text", "synthetic-cookie-value-9251"]) expect(json).not.toContain(raw);
}));

test("sequential evidence isolates same-name calls, consumes replay and retains failed pending calls until expiry", async () => fixture(async store => {
  let now = 1;
  const tracker = new ModelValidationTracker(store, () => now);
  function finish(emitted: string[], returned: string[], failed = false) {
    let outcomes: unknown;
    const d = new ResponsesSafeDiagnostic("synthetic-sequential", now, undefined, (r, e) => { tracker.observe("synthetic-scope", r, e); outcomes = r.correlation_results; }, false);
    d.recordResolvedRouting({ logicalModel: "swe-2", requestedEffort: "high", resolvedModelId: "swe-2-high" });
    d.recordUpstreamResponse(200, true);
    for (const id of emitted) d.recordNormalizedEmittedToolCall({ id, name: "exec_command" });
    for (const id of returned) d.recordNormalizedFunctionCallOutput({ role: "tool", tool_call_id: id, content: "Synthetic output" }, true);
    if (failed) d.recordFailure({ source: "synthetic", classification: "devin_stream_error" }); else d.recordSuccessfulCompletion();
    d.finalize(); return outcomes;
  }
  finish(["synthetic-A"], []);
  expect(finish([], ["synthetic-B"])).toEqual({ no_issued_call: 1 });
  expect(finish(["synthetic-B"], ["synthetic-A"])).toEqual({ matched_success: 1, issued_call_recorded: 1 });
  await tracker.drain(); const first = await store.read();
  expect(first.revision).toBe(2);
  expect(finish([], ["synthetic-A"])).toEqual({ no_issued_call: 1 });
  await tracker.drain(); expect(await store.read()).toEqual(first);
  expect(finish([], ["synthetic-B"], true)).toEqual({ request_ineligible: 1 });
  await tracker.drain(); expect(await store.read()).toEqual(first);
  expect(finish([], ["synthetic-A", "synthetic-B"])).toEqual({ no_issued_call: 1, matched_success: 1 });
  await tracker.drain(); expect((await store.read()).revision).toBe(3);
  expect(finish([], ["synthetic-B"])).toEqual({ no_issued_call: 1 });
  finish(["synthetic-expiring"], []); finish([], ["synthetic-expiring"], true);
  now += 3600001;
  expect(finish([], ["synthetic-expiring"])).toEqual({ expired_pending: 1, no_issued_call: 1 });
  await tracker.drain(); expect((await store.read()).revision).toBe(3);
}));

test("returned evidence considers the first 16 outputs while converter preserves all 17 history items", async () => fixture(async (_store, root) => {
  const { responsesInputToOpenAIMessages, openaiToInternal, toDevinPrompts } = await import("../src/convert.ts");
  const input = Array.from({ length: 17 }, (_, i) => ({ type: "function_call_output", call_id: `synthetic-cap-${i}`, output: `Synthetic output ${i}` }));
  const messages = responsesInputToOpenAIMessages(input);
  expect(toDevinPrompts(openaiToInternal(messages), "synthetic-cascade").map(item => item.toolCallId)).toEqual(input.map(item => item.call_id));
  let captured: string[] = [];
  const path = join(root, "cap-safe.jsonl");
  const d = new ResponsesSafeDiagnostic("synthetic-cap", Date.now(), path, (_record, evidence) => { captured = evidence.returned.map(item => item.id); });
  for (const message of messages) d.recordNormalizedFunctionCallOutput(message, true);
  d.recordSuccessfulCompletion(); d.finalize();
  expect(captured).toEqual(input.slice(0, 16).map(item => item.call_id));
  const safe = await readFile(path, "utf8"); const record = JSON.parse(safe);
  expect(record.tool_evidence_returned_count).toBe(16);
  expect(record.bridge_outcomes.evidence_limit).toBe(1);
  expect(safe).not.toContain("synthetic-cap-"); expect(safe).not.toContain("Synthetic output");
}));

test("new booleans and routing are allowlisted; raw tool/prompt/token content is absent", async () => fixture(async (_store, root) => {
  const path = join(root, "synthetic-safe.jsonl"); const d = new ResponsesSafeDiagnostic("synthetic", Date.now(), path);
  d.addSensitiveValues(["synthetic-private-token"]); d.recordRouting("swe-2", "high", "swe-2-high");
  d.recordEmittedToolCall("exec_command", "synthetic-call"); d.recordFunctionCallOutput("synthetic-call", returnedToolSucceeded('Exit code: 0\nsynthetic-private-output'));
  d.recordSuccessfulCompletion(); d.finalize(); const json = await readFile(path, "utf8"); const r = JSON.parse(json);
  expect(r).toMatchObject({ logical_model: "swe-2", requested_effort: "high", resolved_model_id: "swe-2-high", had_tool_call: true, had_function_call_output: true });
  expect(json).not.toContain("synthetic-private"); expect(json).not.toContain('"returned"'); expect(json).not.toContain('"emitted"');
}));
