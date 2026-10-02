import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../log.js";
import { defaultSettingsDirectory, ModelSelectionStore } from "./model-selection-store.js";
import { isModelId, ModelSelectionError } from "./model-selection.js";
import type { ResponsesSafeDiagnosticRecord, ToolValidationEvidence } from "../responses-diagnostics.js";

const EFFORTS = new Set(["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
type Status = "tested" | "untested";
interface Automatic { source: "automatic"; lastSuccessAt: string; logicalModel: string; effort: string }
interface Manual { source: "manual"; status: Status; updatedAt: string }
interface Variant { automatic?: Automatic; manual?: Manual }
export interface ModelTestStatus { schemaVersion: 1; revision: number; variants: Record<string, Variant> }
export interface EffectiveTestStatus { status: Status; source: "automatic" | "manual" | null; lastSuccessAt?: string; updatedAt?: string }
const fail = (): never => { throw new ModelSelectionError("selection_unavailable", "Model test status storage is unavailable or invalid."); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const timestamp = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const obj = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== "object" || Array.isArray(v)) fail(); return v as Record<string, unknown>; };
const keys = (v: Record<string, unknown>, allowed: string[]) => { if (Object.keys(v).some(k => !allowed.includes(k))) fail(); };
export function validateTestStatus(value: unknown): ModelTestStatus {
  const root = obj(value); keys(root, ["schemaVersion", "revision", "variants"]);
  if (root.schemaVersion !== 1 || !Number.isSafeInteger(root.revision) || (root.revision as number) < 1) fail();
  const input = obj(root.variants); if (Object.keys(input).length > 2048) fail();
  const variants: Record<string, Variant> = Object.create(null);
  for (const [id, raw] of Object.entries(input)) {
    if (!isModelId(id) || ["__proto__", "constructor", "prototype"].includes(id)) fail();
    const row = obj(raw); keys(row, ["automatic", "manual"]); if (!row.automatic && !row.manual) fail();
    const next: Variant = {};
    if (row.automatic) {
      const a = obj(row.automatic); keys(a, ["source", "lastSuccessAt", "logicalModel", "effort"]);
      if (a.source !== "automatic" || !timestamp(a.lastSuccessAt) || !isModelId(a.logicalModel) || typeof a.effort !== "string" || !EFFORTS.has(a.effort)) fail();
      next.automatic = { source: "automatic", lastSuccessAt: a.lastSuccessAt as string, logicalModel: a.logicalModel as string, effort: a.effort as string };
    }
    if (row.manual) {
      const m = obj(row.manual); keys(m, ["source", "status", "updatedAt"]);
      if (m.source !== "manual" || !timestamp(m.updatedAt) || (m.status !== "tested" && m.status !== "untested")) fail();
      next.manual = { source: "manual", status: m.status as Status, updatedAt: m.updatedAt as string };
    }
    variants[id] = next;
  }
  return { schemaVersion: 1, revision: root.revision as number, variants };
}
export function effectiveTestStatus(store: ModelTestStatus, id: string): EffectiveTestStatus {
  const row = store.variants[id];
  return row?.manual ? { ...row.manual, source: "manual", ...(row.automatic ? { lastSuccessAt: row.automatic.lastSuccessAt } : {}) }
    : row?.automatic ? { status: "tested", source: "automatic", lastSuccessAt: row.automatic.lastSuccessAt }
    : { status: "untested", source: null };
}
export const testStatusETag = (s: ModelTestStatus) => `"model-test-status-v1-${s.revision}"`;
async function noSymlinks(path: string) {
  let p = resolve(path);
  for (;;) { try { if ((await lstat(p)).isSymbolicLink()) fail(); } catch (e) { if (!missing(e)) throw e; } const parent = dirname(p); if (parent === p) break; p = parent; }
}
/** Separate file and lock: never updates the user's model selection or its revision. */
export class ModelTestStatusStore {
  readonly directory: string; readonly file: string;
  constructor(directory = defaultSettingsDirectory()) { this.directory = new ModelSelectionStore(directory).directory; this.file = join(this.directory, "model-test-status.json"); }
  async initialize(): Promise<void> {
    await noSymlinks(this.directory); await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
    await this.locked(async () => { try { await this.read(); } catch (e) { if (!missing(e)) throw e; await this.replace({ schemaVersion: 1, revision: 1, variants: {} }); } });
  }
  async read(): Promise<ModelTestStatus> {
    await noSymlinks(this.file);
    const f = await open(this.file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const st = await f.stat(); if (!st.isFile() || st.size > 1048576 || (process.platform !== "win32" && (st.mode & 0o077))) fail();
      try { return validateTestStatus(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await f.readFile()))); } catch { return fail(); }
    } finally { await f.close(); }
  }
  async markManual(id: string, status: Status, expected: string): Promise<ModelTestStatus> {
    if (!isModelId(id) || !["tested", "untested"].includes(status)) throw new ModelSelectionError("invalid_selection", "An exact model ID and tested/untested status are required.");
    return this.update(s => {
      if (testStatusETag(s) !== expected) throw new ModelSelectionError("revision_conflict", "Model test status changed; reload before marking again.");
      s.variants[id] = { ...s.variants[id], manual: { source: "manual", status, updatedAt: new Date().toISOString() } };
    });
  }
  async markAutomatic(id: string, logicalModel: string, effort: string): Promise<void> {
    await this.update(s => { s.variants[id] = { ...s.variants[id], automatic: { source: "automatic", lastSuccessAt: new Date().toISOString(), logicalModel, effort } }; });
  }
  private async update(change: (s: ModelTestStatus) => void): Promise<ModelTestStatus> {
    return this.locked(async () => { const s = await this.read(); change(s); if (s.revision === Number.MAX_SAFE_INTEGER) fail(); s.revision++; const next = validateTestStatus(s); await this.replace(next); return next; });
  }
  private async replace(s: ModelTestStatus) {
    await noSymlinks(this.file); const tmp = join(this.directory, `.test-status-${randomUUID()}.tmp`);
    try { const f = await open(tmp, "wx", 0o600); try { await f.writeFile(JSON.stringify(s) + "\n"); await f.sync(); } finally { await f.close(); } await rename(tmp, this.file); }
    finally { await unlink(tmp).catch(e => { if (!missing(e)) throw e; }); }
  }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    await noSymlinks(this.directory); const lock = join(this.directory, ".test-status-write.lock"); const deadline = Date.now() + 2000;
    for (;;) { try { await mkdir(lock, { mode: 0o700 }); break; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) fail(); await new Promise(r => setTimeout(r, 10)); } }
    try { return await run(); } finally { await rmdir(lock); }
  }
}

/** No raw output retained. Opaque/nonzero/long-running command results cannot prove success. */
export function returnedToolSucceeded(output: unknown): boolean {
  let value = output;
  if (typeof output === "string") {
    if (output.length > 262144) return false;
    try { value = JSON.parse(output); } catch {
      // Native Codex exec envelopes. Require exactly one explicit terminal exit marker.
      const envelope = output.split(/^(?:Output|Final output):/m, 1)[0];
      const codes = [...envelope.matchAll(/^(?:Exit code:\s*|Process exited with code\s+)(-?\d+)\s*$/gm)];
      return codes.length === 1 && codes[0][1] === "0" && !/^Process running with session ID/m.test(envelope);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return !row.error && row.isError !== true && row.session_id === undefined
    && (Object.hasOwn(row, "exit_code") ? row.exit_code === 0 : row.status === "success");
}

/** Bounded memory-only issued-call correlation; never trusts replayed assistant history. */
export class ModelValidationTracker {
  private pending = new Map<string, { model: string; effort: string; expires: number }>();
  private writes = new Set<Promise<void>>();
  constructor(private readonly store: ModelTestStatusStore, private readonly now = Date.now) {}
  observe(scope: string, r: ResponsesSafeDiagnosticRecord, evidence: ToolValidationEvidence): void {
    if (!r.resolved_model_id || !r.logical_model || !r.requested_effort || r.upstream_http_status !== 200
      || r.upstream_terminal_status !== "completed" || r.response_failed_source !== "none" || r.failure_classification) return;
    for (const [key, entry] of this.pending) if (entry.expires < this.now()) this.pending.delete(key);
    for (const returned of evidence.returned) {
      const key = `${scope}:${returned.id}`; const issued = this.pending.get(key);
      if (!issued || issued.model !== r.resolved_model_id || issued.effort !== r.requested_effort) continue;
      this.pending.delete(key);
      if (!returned.success) continue;
      const write = this.store.markAutomatic(r.resolved_model_id, r.logical_model, r.requested_effort).catch(() => { log.warn("[model-test-status] Automatic evidence could not be persisted (details redacted)."); });
      this.writes.add(write); void write.finally(() => this.writes.delete(write));
    }
    for (const call of evidence.emitted) {
      if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(`${scope}:${call.id}`, { model: r.resolved_model_id, effort: r.requested_effort, expires: this.now() + 3600000 });
    }
  }
  async drain(): Promise<void> { await Promise.all(this.writes); }
}
