/** Fold root schema unions for Devin, following Magpie ObjectRoot. This broadens
 * branch constraints: callers must retain their own tool argument validation. */
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const unionKeys = ["anyOf", "oneOf", "allOf"] as const;
const hasUnion = (v: Obj) => unionKeys.some(k => Object.hasOwn(v, k));

export function foldDevinToolSchema(input: string): string {
  let root: unknown;
  try { root = JSON.parse(input); } catch { return input; }
  if (!obj(root) || !hasUnion(root)) return input;
  const document = root;
  const resolve = (value: unknown): Obj | undefined => {
    if (!obj(value)) return undefined;
    if (typeof value.$ref !== "string") return value;
    if (!value.$ref.startsWith("#/$defs/")) throw new Error("Unsupported root union schema reference");
    const key = value.$ref.slice(8).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!obj(document.$defs) || !obj(document.$defs[key])) throw new Error("Unresolved root union schema reference");
    return document.$defs[key] as Obj;
  };
  const fold = (source: Obj, depth: number): Obj => {
    if (depth > 8) throw new Error("Root union schema nesting limit exceeded");
    const result: Obj = { ...source };
    const props: Obj = obj(source.properties) ? { ...source.properties } : {};
    let required = Array.isArray(source.required) ? [...source.required] : [];
    const list = (key: string): unknown[] => {
      if (!Object.hasOwn(source, key)) return [];
      if (!Array.isArray(source[key]) || !(source[key] as unknown[]).length) throw new Error("Invalid root union schema");
      return source[key] as unknown[];
    };
    for (const item of list("allOf")) {
      let branch = resolve(item);
      if (!branch) throw new Error("Unsupported root union schema branch");
      if (hasUnion(branch)) branch = fold(branch, depth + 1);
      if (obj(branch.properties)) for (const [k,v] of Object.entries(branch.properties)) if (!Object.hasOwn(props,k)) props[k]=v;
      if (Array.isArray(branch.required)) required.push(...branch.required);
    }
    delete result.allOf;
    const branches: Obj[] = [];
    for (const key of ["anyOf", "oneOf"]) {
      for (const item of list(key)) {
        let branch = resolve(item);
        if (!branch) throw new Error("Unsupported root union schema branch");
        if (hasUnion(branch)) branch = fold(branch, depth + 1);
        if (branch.type === "object" || obj(branch.properties)) branches.push(branch);
      }
      delete result[key];
    }
    const variants = new Map<string, unknown[]>();
    let common: unknown[] | undefined;
    for (const branch of branches) {
      if (obj(branch.properties)) for (const [k,v] of Object.entries(branch.properties)) {
        if (Object.hasOwn(props,k)) continue;
        const values=variants.get(k) ?? [];
        if (!values.some(x => JSON.stringify(x) === JSON.stringify(v))) values.push(v);
        variants.set(k,values);
      }
      const needed=Array.isArray(branch.required) ? branch.required : [];
      common = common === undefined ? [...needed] : common.filter(x => needed.includes(x));
    }
    for (const [key, values] of variants) props[key]=values.length === 1 ? values[0] : { anyOf: values };
    required=[...new Set([...required,...(common ?? [])])];
    result.type="object"; result.properties=props;
    if (required.length) result.required=required; else delete result.required;
    return result;
  };
  return JSON.stringify(fold(document,0));
}
