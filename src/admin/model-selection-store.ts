import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR } from "../config.js";
import { initialModelSelection, MAX_SELECTION_BYTES, ModelSelectionError, selectionETag, validateModelSelection, type ModelSelection } from "./model-selection.js";

export function defaultSettingsDirectory(): string {
  return process.env.DEVIN_GATEWAY_SETTINGS_DIR ?? join(homedir(), ".devin-gateway-settings");
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const unavailable = (): ModelSelectionError => new ModelSelectionError("selection_unavailable", "Model selection storage is unavailable or invalid; no defaults were substituted.");
async function noSymlinks(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw unavailable(); }
    catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
/** Lock acquisition is bounded. Never steal a possibly active/stale writer's lock. */
export class ModelSelectionStore {
  readonly directory: string;
  readonly file: string;
  constructor(directory = defaultSettingsDirectory(), private readonly lockTimeoutMs = 2000, authDirectory = CONFIG_DIR) {
    this.directory = resolve(directory);
    this.file = join(this.directory, "model-selection.json");
    const overlaps = (parent: string, child: string): boolean => {
      const part = relative(resolve(parent), resolve(child));
      return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
    };
    if (overlaps(authDirectory, this.directory) || overlaps(this.directory, authDirectory)) throw unavailable();
  }
  async initialize(): Promise<ModelSelection> {
    try {
      await noSymlinks(this.directory);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") await chmod(this.directory, 0o700);
      return await this.locked(async () => {
        try { return await this.read(); }
        catch (error) {
          if (!missing(error)) throw error;
          const initial = initialModelSelection();
          await this.replace(initial);
          return initial;
        }
      });
    } catch { throw unavailable(); }
  }
  async read(): Promise<ModelSelection> {
    await noSymlinks(this.file);
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    const file = await open(this.file, flags);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SELECTION_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw unavailable();
      let parsed: unknown;
      try { parsed = JSON.parse(await file.readFile("utf8")); } catch { throw unavailable(); }
      try { return validateModelSelection(parsed); } catch { throw unavailable(); }
    } finally { await file.close(); }
  }
  async update(value: unknown, expectedETag: string): Promise<ModelSelection> {
    const proposed = validateModelSelection(value);
    return this.locked(async () => {
      const current = await this.read();
      if (expectedETag !== selectionETag(current) || proposed.revision !== current.revision) {
        throw new ModelSelectionError("revision_conflict", "Model selection changed; fetch the current revision before saving.");
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) throw unavailable();
      const next = validateModelSelection({ ...proposed, revision: current.revision + 1 });
      await this.replace(next);
      return next;
    });
  }
  private async replace(selection: ModelSelection): Promise<void> {
    await noSymlinks(this.file);
    const temporary = join(this.directory, `.selection-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(selection) + "\n", "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (!missing(error)) throw error; });
    }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await noSymlinks(this.directory);
    const lock = join(this.directory, ".selection-write.lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw unavailable();
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    try { return await operation(); } finally { await rmdir(lock); }
  }
}
