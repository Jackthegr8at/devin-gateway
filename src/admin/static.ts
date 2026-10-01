import { readFile } from "node:fs/promises";
/** Fixed allowlist only: no arbitrary file paths, directory listings or runtime secrets. */
const assets: Record<string, { file: string; type: string }> = {
  "/admin/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/admin/assets/model-picker.js": { file: "model-picker.js", type: "text/javascript; charset=utf-8" },
  "/admin/assets/model-picker.css": { file: "model-picker.css", type: "text/css; charset=utf-8" },
  "/admin/assets/third-party-notices.txt": { file: "third-party-notices.txt", type: "text/plain; charset=utf-8" },
};
const headers = {
  "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "x-frame-options": "DENY", "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
};
export function createAdminStaticHandler(directory = new URL("../../dist/admin-ui/", import.meta.url)) {
  const cache = new Map<string, Promise<Uint8Array>>();
  return async (req: Request): Promise<Response | null> => {
    const path = new URL(req.url).pathname;
    const asset = assets[path];
    if (!asset) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    try {
      let pending = cache.get(asset.file);
      if (!pending) { pending = readFile(new URL(asset.file, directory)).then((bytes) => new Uint8Array(bytes)); cache.set(asset.file, pending); }
      const bytes = await pending;
      return new Response(req.method === "HEAD" ? null : bytes, { headers: { ...headers, "content-type": asset.type } });
    } catch {
      cache.delete(asset.file);
      return Response.json({ error: { code: "admin_assets_unavailable", message: "Build the model picker assets before opening the admin page." } }, { status: 503, headers });
    }
  };
}
