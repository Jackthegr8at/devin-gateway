/** Explicit operator acceptance only: discovery/configuration APIs, never inference or OAuth. */
import assert from "node:assert/strict";

const admin = "http://127.0.0.1:3001";
const gateway = "http://127.0.0.1:3000";
const reviewed = ["glm-5-3-flash-low", "swe-2-medium"];
const efforts = ["low", "medium"];
const synthetic = "synthetic-phase1-unvalidated";
async function request(base: string, path: string, init?: RequestInit) {
  return fetch(base + path, { ...init, signal: AbortSignal.timeout(15_000) });
}
const selectionPath = "/admin/api/model-selection";
async function current() {
  const response = await request(admin, selectionPath);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaVersion, 1);
  assert.ok(Number.isSafeInteger(body.revision) && body.revision >= 1);
  assert.deepEqual(Object.keys(body).sort(), ["enabledModels", "includeFutureModels", "revision", "roles", "schemaVersion"]);
  assert.equal(response.headers.get("etag"), `"model-selection-v1-${body.revision}"`);
  return { body, etag: response.headers.get("etag")! };
}
async function save(body: unknown, etag: string) {
  return request(admin, selectionPath, {
    method: "PUT", headers: { "content-type": "application/json", "x-devin-management": "1", "if-match": etag },
    body: JSON.stringify(body),
  });
}
function sameSelection(a: any, b: any) {
  assert.deepEqual({ ...a, revision: 0 }, { ...b, revision: 0 });
}

const health = await request(gateway, "/health");
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: "ok", fallback_token: "set", collapse_system_enabled: true });
const original = await current();
assert.deepEqual(original.body.enabledModels, reviewed);
assert.deepEqual(original.body.roles, { default: reviewed[0], swe_worker: reviewed[1] });
assert.equal(original.body.includeFutureModels, false);
const modelResponse = await request(admin, "/admin/api/models");
assert.equal(modelResponse.status, 200);
const catalog = await modelResponse.json();
assert.equal(catalog.source, "remote");
assert.equal(catalog.selectionRevision, original.body.revision);
assert.ok(Array.isArray(catalog.models) && catalog.models.length > 0);
assert.ok(!catalog.models.some((model: any) => model.id === synthetic));
const profiles = catalog.models.filter((model: any) => model.codex.status === "validated");
assert.deepEqual(profiles.map((model: any) => model.id).sort(), [...reviewed].sort());
for (const model of catalog.models) {
  assert.equal(typeof model.id, "string"); assert.equal(typeof model.displayName, "string");
  assert.equal(typeof model.available, "boolean"); assert.equal(typeof model.enabled, "boolean");
  assert.ok(model.upstreamThinking === null || typeof model.upstreamThinking === "boolean");
  assert.ok(model.contextWindow === null || Number.isSafeInteger(model.contextWindow));
  assert.ok(model.maxOutputTokens === null || Number.isSafeInteger(model.maxOutputTokens));
  if (model.available) assert.equal(model.metadataProvenance.id, "upstream");
  if (model.codex.status === "unvalidated") assert.equal(model.codex.profile, null);
}
const manifestResponse = await request(gateway, "/gateway/api/codex-selection");
assert.equal(manifestResponse.status, 200);
const manifest = await manifestResponse.json();
assert.deepEqual(Object.keys(manifest).sort(), ["compatibilityProfileVersion", "excludedModels", "includeFutureModels", "models", "revision", "roles", "schemaVersion", "selectionETag"]);
assert.deepEqual(manifest.models.map((model: any) => model.id).sort(), [...reviewed].sort());
for (let index = 0; index < reviewed.length; index++) {
  const model = manifest.models.find((entry: any) => entry.id === reviewed[index]);
  assert.equal(model.defaultReasoningEffort, efforts[index]);
  assert.deepEqual(model.supportedReasoningEfforts.map((row: any) => row.effort), [efforts[index]]);
  assert.ok(model.supportedReasoningEfforts.every((row: any) => typeof row.description === "string"));
}
assert.deepEqual(manifest.roles, { default: { modelId: reviewed[0], reasoningEffort: efforts[0] }, swe_worker: { modelId: reviewed[1], reasoningEffort: efforts[1] } });
console.log(`DISCOVERY_AND_MANIFEST_PASS models=${catalog.models.length} reviewed_profiles=2`);

let changed = false;
try {
  const candidate = { ...original.body, enabledModels: [...reviewed, synthetic] };
  const saved = await save(candidate, original.etag);
  assert.equal(saved.status, 200); changed = true;
  const updated = await current();
  assert.equal(updated.body.revision, original.body.revision + 1);
  assert.ok(updated.body.enabledModels.includes(synthetic));
  assert.equal((await save(candidate, original.etag)).status, 412);
  assert.equal((await save({ ...updated.body, roles: { ...updated.body.roles, swe_worker: "missing-role" } }, updated.etag)).status, 400);
  assert.equal((await save({ ...updated.body, roles: { ...updated.body.roles, swe_worker: synthetic } }, updated.etag)).status, 400);
  assert.deepEqual((await current()).body, updated.body);
  const selected = await request(gateway, "/gateway/api/codex-selection");
  assert.equal(selected.status, 200);
  const selectedBody = await selected.json();
  assert.deepEqual(selectedBody.models.map((model: any) => model.id).sort(), [...reviewed].sort());
  assert.ok(selectedBody.excludedModels.some((model: any) => model.id === synthetic && model.reason === "unavailable"));
  console.log("UPDATE_PASS valid=200 stale=412 invalid_role=400 unvalidated_role=400");
} finally {
  if (changed) {
    const latest = await current();
    assert.equal((await save({ ...original.body, revision: latest.body.revision }, latest.etag)).status, 200);
    const restored = await current();
    sameSelection(restored.body, original.body);
    assert.equal(restored.body.revision, original.body.revision + 2);
    console.log(`RESTORED_TWO_MODEL_SELECTION revision=${restored.body.revision}`);
  }
}
console.log("PHASE1_API_ACCEPTANCE_PASS");
