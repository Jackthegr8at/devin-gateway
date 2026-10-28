// Adapted from Cody lib/model-display.ts (MIT, Copyright (c) 2026 agegr).
// Formatting is display-only; request IDs and search IDs are never rewritten.
function parseGptName(value: string) {
  const normalized = value.trim().split("/").at(-1)?.replace(/[ _]+/g, "-") ?? "";
  const match = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(normalized);
  return match ? { version: match[1], variants: match[2]?.split("-").filter(Boolean) ?? [] } : null;
}
export function formatModelDisplayName(id: string, catalog: string): string {
  const idGpt = parseGptName(id);
  const catalogGpt = parseGptName(catalog);
  const preserves = !idGpt || !catalogGpt || (catalogGpt.version === idGpt.version && idGpt.variants
    .filter((variant) => /[a-z]/i.test(variant))
    .every((variant) => catalogGpt.variants.some((candidate) => candidate.toLowerCase() === variant.toLowerCase())));
  const chosen = catalog.trim() && preserves ? catalogGpt : idGpt;
  if (!chosen) return catalog.trim() || id;
  const variants = chosen.variants.map((variant) => variant === variant.toLowerCase() ? variant.charAt(0).toUpperCase() + variant.slice(1) : variant).join(" ");
  return `GPT-${chosen.version}${variants ? ` ${variants}` : ""}`;
}
