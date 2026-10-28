/** Explicitly invoked, bounded CLI controller. Never prints or saves raw CLI/MCP data. */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { responsesInputToOpenAIMessages, responsesToolsetToDevin, WRITE_STDIN_DEVIN_DESCRIPTION } from "../src/convert.js";
import { diagnosticToolGroup, selectDiagnosticCatalog } from "../src/responses-diagnostic-catalog.js";

function gateway(): string {
  const value = process.env.DEVIN_HARNESS_GATEWAY;
  if (!value) throw new Error("Set DEVIN_HARNESS_GATEWAY");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid DEVIN_HARNESS_GATEWAY");
  return url.origin;
}
const PROMPT = "Use only the configured Memory MCP recall_memory once to retrieve network infrastructure, at most one result. Do not use shell commands, HTTP APIs, credentials, any other tools, or modify memories. Do not quote or summarize memory contents. After a successful MCP result respond only MCP_TEST_COMPLETED and [PROCESS_DONE]. If unavailable, say MCP_TEST_UNAVAILABLE. Do not retry.";
export interface Plan { id: string; selection: string | null; apps: boolean; expectedIdentityHash?: string; writeStdinVariant?: "original" | "description" | "name" }
export function catalogIdentityHash(identities: ReadonlyMap<string, { name: string; namespace?: string }>): string {
  return createHash("sha256").update(JSON.stringify([...identities.values()].map(i => JSON.stringify([i.namespace ?? null, i.name])).sort())).digest("hex");
}
interface SafeDiagnostic {
  request_id: string; tool_count: number; user_input_sha256?: string;
  responses_terminal_status?: string; failure_classification?: string; connect_error_code?: string;
  connect_error_message?: string; upstream_http_statuses?: Array<{ stage: string; status: number }>;
  responses_tool_call_emitted_count?: number; had_function_call_output?: boolean;
}
export class RunBudget {
  used = 0;
  constructor(readonly limit: number) { if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error("Budget must be 1..12"); }
  take() { if (this.used >= this.limit) throw new Error("Live test budget exhausted"); this.used++; }
}
export function isRecall(item: Record<string, unknown>): boolean {
  return (item.namespace === "mcp__memory" && item.name === "recall_memory")
    || (item.namespace === undefined && item.name === "mcp__memory__recall_memory");
}
export function checkResponseEvent(event: Record<string, any>, recallIds?: Set<string>): void {
  for (const item of event.response?.output ?? []) checkResponseEvent({ item }, recallIds);
  const item = event.item;
  if (!item) return;
  if (item.type === "function_call" && isRecall(item)) {
    if (recallIds) {
      if (typeof item.call_id !== "string" || !item.call_id) throw new Error("missing_call_id");
      recallIds.add(item.call_id);
      if (recallIds.size > 1) throw new Error("recall_limit");
    }
    return;
  }
  // Assistant text/reasoning are inert. Every other action fails closed.
  if (!["message", "reasoning"].includes(item.type)) throw new Error("unsafe_tool_attempt");
}

export function requestCatalog(body: Record<string, any>) {
  return responsesToolsetToDevin([...(body.tools ?? []), ...(Array.isArray(body.input) ? body.input.filter((i: any) => i?.type === "additional_tools") : [])]);
}

/** Opt-in controller experiment only; never used by the gateway or normal requests. */
export function writeStdinDiagnosticBody(body: Record<string, any>, variant: NonNullable<Plan["writeStdinVariant"]>) {
  const full = requestCatalog(body);
  const memory = selectDiagnosticCatalog(full, "memory-only");
  const stdin = full.tools.find(tool => { const i = full.identities.get(tool.name); return i?.namespace === undefined && i?.name === "write_stdin"; });
  if (!stdin) throw new Error("write_stdin declaration missing");
  let rawDescription = "";
  const readOriginal = (tools: any[]) => { for (const tool of tools) {
    if (tool?.type === "additional_tools") readOriginal(tool.tools);
    if (tool?.type === "function" && tool.name === "write_stdin") rawDescription = tool.description ?? "";
  } };
  readOriginal([...(body.tools ?? []), ...(Array.isArray(body.input) ? body.input.filter((i: any) => i?.type === "additional_tools") : [])]);
  const groups = new Map<string, any[]>();
  const tools: any[] = [];
  for (const tool of [...memory.tools, stdin]) {
    const identity = full.identities.get(tool.name)!;
    const declaration = { type: "function", name: identity.name, description: tool.description, parameters: JSON.parse(tool.jsonSchemaString), strict: tool.strict };
    if (identity.name === "write_stdin" && identity.namespace === undefined) {
      declaration.description = rawDescription;
      if (variant === "description") declaration.description = WRITE_STDIN_DEVIN_DESCRIPTION;
      if (variant === "name") declaration.name = "codex_write_stdin";
    }
    if (identity.namespace) { const list = groups.get(identity.namespace) ?? []; list.push(declaration); groups.set(identity.namespace, list); }
    else tools.push(declaration);
  }
  for (const [name, functions] of groups) tools.push({ type: "namespace", name, tools: functions });
  return { ...body, tools, input: Array.isArray(body.input) ? body.input.map((i: any) => i?.type === "additional_tools" ? { ...i, tools } : i) : body.input };
}

/** No production access: captures catalog structure against a rejecting local mock. */
export async function probeCLI(cli: string, apps: boolean) {
  const cwd = mkdtempSync(join(tmpdir(), "codex-catalog-probe-"));
  let catalog: ReturnType<typeof requestCatalog> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET" && new URL(req.url).pathname === "/v1/models") return Response.json({ data: [] });
    if (req.method === "POST" && new URL(req.url).pathname === "/v1/responses") {
      try { catalog = requestCatalog(await req.json() as Record<string, unknown>); } catch { /* No raw request/error retained. */ }
    }
    return new Response("Offline catalog probe complete", { status: 400 });
  } });
  const child = spawn(cli, cliArgs(server.url.origin, cwd, { id: "offline", apps, selection: null }), { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
  const timer = setTimeout(() => {
    if (child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
  }, 30000);
  child.stdin!.on("error", () => {}); child.stdin!.end(PROMPT);
  await new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  clearTimeout(timer); await server.stop(true); rmSync(cwd, { recursive: true, force: true });
  const groups: Record<string, number> = {};
  let memory = false;
  if (catalog) {
    for (const identity of catalog.identities.values()) { const group = diagnosticToolGroup(identity); groups[group] = (groups[group] ?? 0) + 1; }
    try { selectDiagnosticCatalog(catalog, "memory-only"); memory = true; } catch { /* Explicitly report missing baseline. */ }
  }
  return { apps, candidate_count: catalog?.tools.length ?? 0, memory_available: memory, groups };
}
export function cliArgs(base: string, cwd: string, plan: Plan): string[] {
  return ["exec", "--json", "--ephemeral", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check", "-C", cwd,
    // exec starts its first turn immediately; optional stdio MCP discovery can
    // still be in flight. Await this test's prerequisite instead of sleeping.
    "-c", "mcp_servers.memory.required=true",
    "-m", "swe-2", "-c", "model_reasoning_effort=medium", "-c", "model_provider=catalog_harness",
    "-c", "model_providers.catalog_harness.name=Catalog-harness", "-c", `model_providers.catalog_harness.base_url=${base}/v1`,
    "-c", "model_providers.catalog_harness.wire_api=responses", "-c", "model_providers.catalog_harness.request_max_retries=0",
    "-c", "model_providers.catalog_harness.stream_max_retries=0", "-c", "features.unbounded_connection_retries=false",
    ...(plan.apps ? [] : ["--disable", "apps"]), "-"];
}
export function classify(records: SafeDiagnostic[], cliRecall: boolean, cliFinished: boolean, exit: number | null): string {
  if (records.some(r => r.connect_error_code === "permission_denied")) return "permission_denied";
  if (records.some(r => r.responses_terminal_status === "failed")) return "gateway_failure";
  if (!records.length) return "uncorrelated";
  if (exit !== 0 || !cliFinished) return "cli_incomplete";
  if (!cliRecall || !records.some(r => (r.responses_tool_call_emitted_count ?? 0) > 0)
    || !records.some(r => r.had_function_call_output && r.responses_terminal_status === "completed")) return "no_mcp_completion";
  return "success";
}

export async function safeDiagnostics(hashes: string[]): Promise<SafeDiagnostic[]> {
  if (!hashes.every(h => /^[a-f0-9]{64}$/.test(h))) throw new Error("Invalid correlation digest");
  const remoteDir = process.env.DEVIN_OPERATOR_REMOTE_DIR;
  if (!remoteDir || !/^\/[A-Za-z0-9/_-]+$/.test(remoteDir)) throw new Error("Set valid DEVIN_OPERATOR_REMOTE_DIR");
  const code = `import json\nfrom collections import deque\nhashes=set(${JSON.stringify(hashes)})\nkeys=['request_id','tool_count','user_input_sha256','responses_terminal_status','failure_classification','connect_error_code','connect_error_message','upstream_http_statuses','responses_tool_call_emitted_count','had_function_call_output']\nwith open(${JSON.stringify(remoteDir + '/logs/responses-safe-diagnostic.jsonl')}) as f: rows=deque(f,maxlen=200)\nfor line in rows:\n r=json.loads(line)\n if r.get('user_input_sha256') in hashes: print(json.dumps({k:r[k] for k in keys if k in r}))\n`;
  const key = process.env.DEVIN_OPERATOR_SSH_KEY;
  const target = process.env.DEVIN_OPERATOR_SSH_TARGET;
  if (!key || !target || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(target)) throw new Error("Set valid DEVIN_OPERATOR_SSH_KEY and DEVIN_OPERATOR_SSH_TARGET");
  return await new Promise((resolve, reject) => {
    const child = spawn("ssh.exe", ["-i", key, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, "sudo -n python3 -"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("diagnostic_read_timeout")); }, 15000);
    child.stdout.on("data", b => { output += b.toString(); if (output.length > 128000) { child.kill(); reject(new Error("diagnostic_limit")); } });
    child.stderr.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error("diagnostic_read_failed")); });
    child.on("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error("diagnostic_read_failed")); else {
      try { resolve(output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))); } catch { reject(new Error("diagnostic_parse_failed")); }
    } });
    child.stdin.end(code);
  });
}

export async function runOne(cli: string, plan: Plan, timeoutMs: number, budget: RunBudget, output: string): Promise<string> {
  budget.take();
  const testId = `mcp-${plan.id}-${randomUUID().slice(0, 8)}`;
  const cwd = mkdtempSync(join(tmpdir(), "codex-mcp-harness-"));
  const abort = new AbortController();
  const hashes = new Set<string>();
  const recallIds = new Set<string>();
  let requestCount = 0, recall = false, finished = false, failure = "", bytes = 0;
  let child: ReturnType<typeof spawn> | undefined;
  const cancel = (reason: string) => {
    if (!failure) failure = reason;
    abort.abort();
    if (child?.pid && child.exitCode === null) {
      // Only this child tree, never the Desktop/controller or another session.
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { child?.kill(); });
    }
  };
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120,
    async fetch(req) {
      try {
        if (new URL(req.url).pathname === "/v1/models" && req.method === "GET") {
          const headers = new Headers(req.headers); headers.delete("host");
          return await fetch(gateway() + "/v1/models", { headers, signal: abort.signal });
        }
        if (new URL(req.url).pathname !== "/v1/responses" || req.method !== "POST") { cancel("unexpected_endpoint"); return new Response(null, { status: 400 }); }
        if (++requestCount > 3) { cancel("request_budget"); return new Response(null, { status: 429 }); }
        const raw = await req.text();
        if (raw.length > 8 * 1024 * 1024) throw new Error("request_size");
        const body = plan.writeStdinVariant ? writeStdinDiagnosticBody(JSON.parse(raw), plan.writeStdinVariant) : JSON.parse(raw);
        if (body.model !== "swe-2" || body.reasoning?.effort !== "medium") throw new Error("unexpected_model");
        try { selectDiagnosticCatalog(requestCatalog(body), "memory-only"); }
        catch { cancel("missing_memory_declarations"); return new Response(null, { status: 400 }); }
        if (plan.expectedIdentityHash && catalogIdentityHash(selectDiagnosticCatalog(requestCatalog(body), plan.selection).identities) !== plan.expectedIdentityHash) {
          cancel("catalog_identity_mismatch"); return new Response(null, { status: 400 });
        }
        const messages = responsesInputToOpenAIMessages(body.input);
        const user = messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : (m.content ?? []).filter(p => p.type === "input_text" || p.type === "text").map(p => p.text ?? "").join("\n")).join("\n");
        hashes.add(createHash("sha256").update(user).digest("hex"));
        const headers = new Headers(req.headers); headers.delete("host"); headers.delete("content-length");
        headers.delete("x-devin-diagnostic-tool-catalog");
        if (plan.selection) headers.set("x-devin-diagnostic-tool-catalog", plan.selection);
        const response = await fetch(gateway() + "/v1/responses", { method: "POST", headers, body: plan.writeStdinVariant ? JSON.stringify(body) : raw, signal: abort.signal });
        if (!response.body) throw new Error("empty_response");
        if (!response.ok) { cancel("http_rejection"); return new Response(null, { status: response.status }); }
        const reader = response.body.getReader();
        const decoder = new TextDecoder(); let pending = "";
        return new Response(new ReadableStream({ async start(controller) {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) { if (pending.trim()) throw new Error("incomplete_sse"); controller.close(); break; }
              pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
              if (pending.length > 2 * 1024 * 1024) throw new Error("event_size");
              let end: number;
              while ((end = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, end); pending = pending.slice(end + 2);
                for (const line of frame.split("\n")) if (line.startsWith("data: ") && line.slice(6) !== "[DONE]") checkResponseEvent(JSON.parse(line.slice(6)), recallIds);
                controller.enqueue(new TextEncoder().encode(frame + "\n\n"));
              }
            }
          } catch { cancel("unsafe_or_invalid_stream"); controller.error(new Error("Harness stopped the stream")); }
          finally { await reader.cancel().catch(() => {}); }
        }, cancel() { cancel("client_cancelled"); } }), { status: response.status, headers: { "content-type": "text/event-stream" } });
      } catch { cancel("unexpected_request"); return new Response(null, { status: 502 }); }
    },
  });
  const timer = setTimeout(() => cancel("timeout"), timeoutMs);
  const interrupt = () => cancel("cancelled"); process.once("SIGINT", interrupt);
  let exit: number | null = null;
  try {
    child = spawn(cli, cliArgs(proxy.url.origin, cwd, plan), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let pending = "";
    child.stdout!.on("data", data => {
      bytes += data.length; if (bytes > 2 * 1024 * 1024) { cancel("output_limit"); return; }
      pending += data.toString(); let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let e: any; try { e = JSON.parse(line); } catch { cancel("invalid_cli_event"); return; }
        const item = e.item;
        if (item?.type === "mcp_tool_call") {
          if (item.server !== "memory" || item.tool !== "recall_memory") { cancel("unsafe_cli_tool"); return; }
          if (e.type === "item.completed" && item.status === "completed" && !item.error && !item.result?.isError) recall = true;
        }
        if (item && ["command_execution", "file_change", "web_search", "collab_tool_call"].includes(item.type)) { cancel("unsafe_cli_action"); return; }
        if (e.type === "turn.completed") finished = true;
      }
    });
    child.stderr!.on("data", data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) cancel("output_limit"); });
    child.stdin!.on("error", () => {});
    child.stdin!.end(PROMPT + `\nDiagnostic test identifier: ${testId}`);
    exit = await new Promise<number | null>(resolve => { child!.once("error", () => { failure = "cli_start_failed"; resolve(null); }); child!.once("close", resolve); });
  } finally {
    clearTimeout(timer); process.removeListener("SIGINT", interrupt); abort.abort(); await proxy.stop(true);
    rmSync(cwd, { recursive: true, force: true });
  }
  // Gateway finalization can follow the last emitted SSE event by a few milliseconds.
  await new Promise(resolve => setTimeout(resolve, 300));
  let records: SafeDiagnostic[] = [];
  try { records = await safeDiagnostics([...hashes]); } catch { failure ||= "diagnostic_read_failed"; }
  const counts = [...new Set(records.map(r => r.tool_count))];
  const result = failure || (counts.length > 1 ? "catalog_changed" : classify(records, recall, finished, exit));
  const summary = { test_id: testId, catalog_selection: `${plan.selection ?? "full"};apps=${plan.apps}${plan.writeStdinVariant ? `;write_stdin=${plan.writeStdinVariant}` : ""}`, tool_counts: [...new Set(records.map(r => r.tool_count))], result,
    error_class: records.find(r => r.failure_classification)?.failure_classification ?? (result === "success" ? null : result),
    request_ids: records.map(r => r.request_id), upstream_statuses: records.flatMap(r => r.upstream_http_statuses ?? []) };
  appendFileSync(output, JSON.stringify(summary) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(summary));
  return result;
}

if (import.meta.main) {
  if (!process.argv.includes("--run") && !process.argv.includes("--probe")) { console.log("Use --probe for offline catalogs; --run for up to four sequential live CLI tests (hard batch cap 12). No deployment."); process.exit(0); }
  const base = join(process.env.USERPROFILE!, "AppData", "Local", "OpenAI", "Codex", "bin");
  const candidates = readdirSync(base).map(dir => join(base, dir, "codex.exe")).filter(existsSync);
  const cliIndex = process.argv.indexOf("--cli");
  const cli = cliIndex >= 0 ? process.argv[cliIndex + 1] : candidates.length === 1 ? candidates[0] : undefined;
  if (!cli) throw new Error("Installed CLI not found");
  const probes = [];
  for (const apps of [true, false]) { const probe = await probeCLI(cli, apps); probes.push(probe); console.log(JSON.stringify({ offline_catalog_probe: probe })); }
  if (!process.argv.includes("--run")) process.exit(0);
  if (probes.some(p => !p.memory_available)) { console.log("Batch stopped before inference: CLI child does not declare all six Memory tools."); process.exitCode = 1; }
  else {
  const output = join(import.meta.dir, "..", "deploy", "operator", "test-results", `catalog-${Date.now()}.jsonl`);
  mkdirSync(dirname(output), { recursive: true });
  const budgetIndex = process.argv.indexOf("--max-runs");
  const budget = new RunBudget(budgetIndex >= 0 ? Number(process.argv[budgetIndex + 1]) : 12);
  const plans: Plan[] = [
    { id: "memory-apps-on", selection: "memory-only", apps: true },
    { id: "memory-apps-off", selection: "memory-only", apps: false },
    { id: "full-apps-off", selection: null, apps: false },
    { id: "full-apps-on", selection: null, apps: true },
  ];
  let stopped = false;
  const results = new Map<string, string>();
  for (const plan of plans) {
    if (budget.used >= budget.limit) break;
    const result = await runOne(cli, plan, 120000, budget, output);
    results.set(plan.id, result);
    if (!["success", "permission_denied"].includes(result) || (plan.selection === "memory-only" && result !== "success")) { stopped = true; break; }
  }
  if (process.argv.includes("--isolate") && !stopped && results.get("full-apps-on") === "permission_denied") {
    // Test every namespace independently; recurse into BOTH failing halves so
    // multiple incompatible declarations are not mistaken for one culprit.
    const queue = Object.entries(probes[0].groups).filter(([g]) => g !== "ns.mcp__memory").sort(([a], [b]) => a < b ? -1 : 1)
      .map(([group, count]) => ({ group, start: 0, end: count - 1, full: true }));
    let groupFailure = false;
    while (queue.length && budget.used < budget.limit) {
      const next = queue.shift()!;
      const selection = `memory+group:${next.group}` + (next.full ? "" : `@${next.start}-${next.end}`);
      const result = await runOne(cli, { id: "group-isolation", selection, apps: true }, 120000, budget, output);
      if (!["success", "permission_denied"].includes(result)) break;
      if (result === "permission_denied" && next.end > next.start) {
        groupFailure = true;
        const mid = Math.floor((next.start + next.end) / 2);
        queue.unshift({ ...next, start: mid + 1, full: false }, { ...next, end: mid, full: false });
      }
      if (result === "permission_denied") groupFailure = true;
    }
    // A minimal failing prefix can be an interaction, not necessarily a size
    // limit. Keep that distinction in interpretation of the saved summaries.
    if (!queue.length && !groupFailure && budget.used < budget.limit) {
      let low = 0, high = probes[0].candidate_count - 6;
      while (high - low > 1 && budget.used < budget.limit) {
        const mid = Math.floor((low + high) / 2);
        const result = await runOne(cli, { id: "prefix-isolation", selection: `memory+range:0-${mid - 1}`, apps: true }, 120000, budget, output);
        if (result === "success") low = mid;
        else if (result === "permission_denied") high = mid;
        else break;
      }
    }
  }
  }
}
