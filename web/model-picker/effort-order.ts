/** Display order only: never adds capabilities or changes a concrete route. */
export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const DISPLAY_ORDER: readonly string[] = ["off", "minimal", ...EFFORT_ORDER];
export function compareEfforts(a: string, b: string): number {
  const rank = (effort: string) => {
    const index = DISPLAY_ORDER.indexOf(effort);
    return index < 0 ? DISPLAY_ORDER.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
/** Keep family positions/standalone order, but make each family's variants contiguous and ordered. */
export function orderFamilyVariants<T extends { id: string; family?: { id: string; effort: string } }>(models: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const key = model.family ? `family:${model.family.id}` : `model:${model.id}`;
    const group = groups.get(key) ?? [];
    group.push(model); groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => group[0].family
    ? [...group].sort((a, b) => compareEfforts(a.family!.effort, b.family!.effort)) : group);
}
