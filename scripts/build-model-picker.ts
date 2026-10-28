import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist/admin-ui");
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "web/model-picker/main.tsx")], outdir: output,
  naming: "model-picker.[ext]", target: "browser", minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) { console.error("Model picker build failed.", result.logs); process.exit(1); }
await Promise.all([
  copyFile(join(root, "web/model-picker/index.html"), join(output, "index.html")),
  copyFile(join(root, "web/model-picker/styles.css"), join(output, "model-picker.css")),
]);
const notices = await Promise.all([
  readFile(join(root, "web/model-picker/THIRD_PARTY_NOTICES.txt"), "utf8"),
  readFile(join(root, "node_modules/react/LICENSE"), "utf8"),
  readFile(join(root, "node_modules/react-dom/LICENSE"), "utf8"),
]);
await writeFile(join(output, "third-party-notices.txt"), notices.join("\n\n"));
for (const asset of result.outputs) console.log(`Model picker bundle: ${asset.size} bytes`);
