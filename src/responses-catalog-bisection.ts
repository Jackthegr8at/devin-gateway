import { createHash } from "node:crypto";
import { ResponsesInputError, type OpenAIMessage, type ResponsesToolset } from "./convert.js";

export const BISECTION_ENV = "DEVIN_RESPONSES_CATALOG_BISECTION";

/** Normalize only the per-chat visualization UUID in verified Codex context blocks. */
export function normalizeBisectionRequest(body: unknown): Record<string, unknown> {
  const source = body as Record<string, unknown>;
  const copy = JSON.parse(JSON.stringify({ ...source, tools: undefined })) as Record<string, unknown>;
  const input = Array.isArray(copy.input) ? copy.input : [];
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const messageId = /^msg_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  // The gateway ignores message IDs; retain their presence and reject other ID formats.
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row=item as Record<string, unknown>;
    if (row.type === "message" && (row.role === "developer" || row.role === "user") && typeof row.id === "string" && messageId.test(row.id)) row.id="<message-id>";
  }
  const metadata = copy.client_metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const outer=metadata as Record<string, unknown>;
    const raw=outer["x-codex-turn-metadata"];
    if (typeof raw === "string") {
      try {
        const inner=JSON.parse(raw) as Record<string, unknown>;
        const ids=["session_id","thread_id","turn_id","root_turn_id"];
        const consistent=inner && typeof inner === "object" && !Array.isArray(inner) && ids.every(k=>typeof outer[k] === "string" && uuid.test(outer[k] as string) && outer[k] === inner[k]);
        if (consistent) {
          const session=outer.session_id, thread=outer.thread_id;
          if (typeof copy.prompt_cache_key === "string" && (copy.prompt_cache_key === session || copy.prompt_cache_key === thread)) copy.prompt_cache_key="<session-cache-key>";
          for (const k of ids) { outer[k]=`<${k}>`; inner[k]=`<${k}>`; }
          if (typeof outer["x-codex-window-id"] === "string" && outer["x-codex-window-id"] === inner.window_id) {outer["x-codex-window-id"]="<window-id>";inner.window_id="<window-id>";}
          if (typeof inner.context_window_id === "string" && uuid.test(inner.context_window_id)) inner.context_window_id="<context-window-id>";
          if (typeof inner.turn_started_at_unix_ms === "number" && Number.isSafeInteger(inner.turn_started_at_unix_ms)) inner.turn_started_at_unix_ms="<turn-start>";
          outer["x-codex-turn-metadata"]=JSON.stringify(inner);
        }
      } catch { /* Unknown metadata is kept byte-for-byte. */ }
    }
  }
  const blocks: Array<{ part: Record<string, unknown>; role: string }> = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row=item as Record<string, unknown>;
    if ((row.role !== "developer" && row.role !== "user") || !Array.isArray(row.content)) continue;
    for (const raw of row.content) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const part=raw as Record<string, unknown>, text=part.text;
      if (part.type !== "input_text" || typeof text !== "string") continue;
      const start=row.role === "developer" ? "<permissions instructions>" : "<environment_context>";
      const end=row.role === "developer" ? "</permissions instructions>" : "</environment_context>";
      if (text.trim().startsWith(start) && text.trim().endsWith(end)) blocks.push({part,role:row.role});
    }
  }
  // Keep every path component except the verified conversation UUID. Do not
  // normalize arbitrary user messages, other roots, or multiple distinct roots.
  const path = /([A-Za-z]:[\\/]Users[\\/][^\\/\r\n<>"]+[\\/]\.codex[\\/]visualizations[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[\\/\s<>"'`])/gi;
  const roots=new Set<string>(); const roles=new Set<string>();
  for (const {part,role} of blocks) for (const m of (part.text as string).matchAll(path)) {roots.add((m[1]+m[2]).toLowerCase().replaceAll("\\","/"));roles.add(role);}
  if (roots.size === 1 && roles.has("developer") && roles.has("user")) {
    for (const {part} of blocks) part.text=(part.text as string).replace(path,(_all,prefix:string)=>prefix+"<conversation-id>");
  }
  return copy;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalJson(item)]));
  return value;
}

export function bisectionRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(normalizeBisectionRequest(body)))).digest("hex");
}


/** Fingerprint the exact converted declarations, identities and original ordering. */
export function catalogBisectionFingerprint(toolset: ResponsesToolset): string {
  const ordered = toolset.tools.map(tool => [tool, toolset.identities.get(tool.name) ?? null]);
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
}

export type BisectionResult = { toolset: ResponsesToolset; fingerprint: string; ordinals: number[]; mode: "observe" | "keep" | "drop" };

/** The caller must explicitly opt in; a mismatch or unsafe request never reaches upstream. */
export function selectBisectionCatalog(toolset: ResponsesToolset, selection: string, options: {
  enabled: boolean; model: unknown; effort: unknown; guardian: boolean; legacySelector: boolean;
  messages: OpenAIMessage[]; toolChoice: unknown; diagnosticsEnabled: boolean;
}): BisectionResult {
  const fail = (reason: string): never => { throw new ResponsesInputError(`Catalog bisection: ${reason}`); };
  if (!options.enabled || !options.diagnosticsEnabled) fail("disabled or safe and full diagnostics unavailable.");
  if (options.guardian || options.legacySelector || options.model !== "claude-haiku-5-5" || options.effort !== "high") fail("request is not an eligible targeted Haiku High request.");
  if (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none") fail("forced tool choice is unsupported.");
  if (options.messages.some(m => m.role === "tool" || (m.tool_calls && m.tool_calls.length > 0))) fail("tool history is unsupported.");
  if (toolset.tools.length === 0 || toolset.tools.length > 512 || toolset.identities.size !== toolset.tools.length) fail("catalog is empty, too large, or has ambiguous identities.");
  const fingerprint = catalogBisectionFingerprint(toolset);
  if (selection === "observe") return { toolset, fingerprint, ordinals: toolset.tools.map((_, i) => i), mode: "observe" };
  if (selection === "first-half") {
    if (toolset.tools.length < 2) fail("catalog needs at least two tools.");
    const ordinals = toolset.tools.map((_, i) => i).filter(i => i < Math.ceil(toolset.tools.length / 2));
    const tools=ordinals.map(i => toolset.tools[i]);
    return {toolset:{...toolset,tools,identities:new Map(tools.map(tool=>[tool.name,toolset.identities.get(tool.name)!]))},fingerprint,ordinals,mode:"keep"};
  }
  const match = /^(keep|drop):([a-f0-9]{64}):(\d+)-(\d+)$/.exec(selection);
  if (!match) fail("invalid selector.");
  const [, action, pinned, first, last] = match!;
  if (pinned !== fingerprint) fail("catalog fingerprint mismatch.");
  const start = Number(first), end = Number(last);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= toolset.tools.length) fail("range outside catalog.");
  const ordinals = toolset.tools.map((_, i) => i).filter(i => action === "keep" ? i >= start && i <= end : i < start || i > end);
  if (!ordinals.length) fail("selection is empty.");
  const tools = ordinals.map(i => toolset.tools[i]);
  const identities = new Map(tools.map(tool => [tool.name, toolset.identities.get(tool.name)!]));
  return { toolset: { ...toolset, tools, identities }, fingerprint, ordinals, mode: action as "keep" | "drop" };
}
