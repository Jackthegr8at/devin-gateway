/** Synthetic catalog only: no real tool descriptions, prompts or credentials. */
export const catalogAgentNames = ["spawn_agent", "send_input", "wait_agent", "resume_agent", "close_agent"];

export function catalogSchema(index: number, padding = 1024): Record<string, unknown> {
  let nested: Record<string, unknown> = { type: "string", enum: ["synthetic-one", "synthetic-two"] };
  for (let depth = 0; depth < 8; depth++) nested = { type: "object", properties: { nested }, additionalProperties: false };
  return {
    type: "object", properties: {
      marker: { type: "string", const: `synthetic-schema-${index}`, description: "Synthetic private schema text " + "x".repeat(padding) },
      nested,
      entries: { type: "array", items: { anyOf: [{ type: "null" }, { type: "integer" }] } },
      optional: { type: ["string", "null"] },
    }, required: ["marker"], additionalProperties: false,
  };
}

/** Large incoming catalog; exactly six currently reviewed functions survive filtering. */
export function incomingCatalog(count: number, padding = 1024): Record<string, unknown>[] {
  const catalog: Record<string, unknown>[] = Array.from({ length: count }, (_, index) => ({
    type: "function", name: `synthetic_search_${index}`, description: "Synthetic private tool description",
    parameters: catalogSchema(index, padding), strict: index % 2 === 0,
  }));
  catalog.splice(Math.floor(count / 2), 0, {
    type: "function", name: "exec_command", description: "Synthetic private original command description",
    parameters: catalogSchema(1000, padding), strict: true,
  });
  catalog.push({ type: "namespace", name: "multi_agent_v1", tools: catalogAgentNames.map((name, index) => ({
    type: "function", name, description: `Synthetic private agent description ${index}`,
    parameters: catalogSchema(2000 + index, padding), strict: index % 2 === 0,
  })) });
  for (const name of ["namespace_a", "namespace_b", "N".repeat(256)]) catalog.push({
    type: "namespace", name, tools: ["search", "read", "exec_command", "spawn_agent"].map(leaf => ({
      type: "function", name: leaf, parameters: catalogSchema(3000, padding),
    })),
  });
  return catalog;
}
