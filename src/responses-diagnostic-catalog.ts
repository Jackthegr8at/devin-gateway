import { ResponsesInputError, type ResponsesToolset } from "./convert.js";

export const DIAGNOSTIC_CATALOG_HEADER = "x-devin-diagnostic-tool-catalog";
export const MEMORY_TOOL_NAMES = ["associate_memories", "check_database_health", "delete_memory", "recall_memory", "store_memory", "update_memory"] as const;
export const DIAGNOSTIC_CATALOG_NOTICE = "[Gateway diagnostic tool catalog]\nThis request explicitly selected a reduced Memory-centered diagnostic catalog. Only currently declared functions are available. Other capabilities described in instructions or history are unavailable for this diagnostic request. Do not invoke them or invent a substitute. MCP execution remains in Codex.";

export function diagnosticToolGroup(identity: { namespace?: string }): string {
  return identity.namespace === undefined ? "native" : `ns.${identity.namespace}`;
}

/** Stable ordinal identity order, independent of declaration order or locale. */
function orderedExtras(toolset: ResponsesToolset, memory: ReadonlyMap<string, unknown>) {
  return [...toolset.identities].filter(([name]) => !memory.has(name)).sort((a, b) => {
    const left = JSON.stringify([a[1].namespace ?? null, a[1].name]);
    const right = JSON.stringify([b[1].namespace ?? null, b[1].name]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Select only after all top-level/additional declarations have been validated and mapped. */
export function selectDiagnosticCatalog(toolset: ResponsesToolset, selection: string | null): ResponsesToolset {
  if (selection === null) return toolset;
  if (selection.length > 256 || !/^(memory-only|memory\+range:\d+-\d+|memory\+group:[A-Za-z0-9_.-]+(?:@\d+-\d+)?)$/.test(selection)) {
    throw new ResponsesInputError(`Unsupported ${DIAGNOSTIC_CATALOG_HEADER}; use memory-only, memory+group:<group>[@<start>-<end>], or memory+range:<start>-<end>.`);
  }
  const memory = new Set<string>(MEMORY_TOOL_NAMES);
  const found = new Set<string>();
  const identities = new Map([...toolset.identities].filter(([, identity]) => {
    const name = identity.namespace === "mcp__memory" ? identity.name
      : identity.namespace === undefined && identity.name.startsWith("mcp__memory__") ? identity.name.slice("mcp__memory__".length) : undefined;
    if (name !== undefined && memory.has(name)) {
      if (found.has(name)) throw new ResponsesInputError("Memory-only diagnostic requires one unambiguous declaration per Memory function.");
      found.add(name);
      return true;
    }
    return false;
  }));
  if (found.size !== MEMORY_TOOL_NAMES.length) throw new ResponsesInputError("Memory-only diagnostic requires all six declared Memory MCP functions; no upstream inference was started.");
  if (selection !== "memory-only") {
    const parts = selection.match(/^memory\+group:([A-Za-z0-9_.-]+)(?:@(\d+)-(\d+))?$/);
    const candidates = orderedExtras(toolset, identities).filter(([, identity]) => !parts || diagnosticToolGroup(identity) === parts[1]);
    if (candidates.length === 0) throw new ResponsesInputError("Diagnostic group has no declared extra tools.");
    const range = parts ? parts[2] === undefined ? undefined : [Number(parts[2]), Number(parts[3])]
      : selection.slice("memory+range:".length).split("-").map(Number);
    const [start, end] = range ?? [0, candidates.length - 1];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= candidates.length) throw new ResponsesInputError("Diagnostic tool range is outside the current declared catalog.");
    for (const [name, identity] of candidates.slice(start, end + 1)) identities.set(name, identity);
  }
  const tools = toolset.tools.filter(tool => identities.has(tool.name));
  if (selection === "memory-only" && tools.length !== 6) throw new ResponsesInputError("Memory-only diagnostic requires one unambiguous declaration per Memory function.");
  return { ...toolset, tools, identities };
}
