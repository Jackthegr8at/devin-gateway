import { lstatSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ResponsesInputError } from "./convert.js";

export interface DiagnosticArm { id: string; expiresAt: number; selection: string; requestSha256: string | null }
function readArm(directory: string, now: number): DiagnosticArm | undefined {
  const fail = (): never => { throw new ResponsesInputError("Catalog bisection arm is invalid or unavailable."); };
  const source=join(directory,"arm.json"), claimed=join(directory,`.claimed-${randomUUID()}.json`);
  try {
    const dir=lstatSync(directory); if(!dir.isDirectory() || dir.isSymbolicLink() || (process.platform!=="win32" && (dir.mode & 0o077)!==0)) return fail();
    const st=lstatSync(source); if(!st.isFile() || st.isSymbolicLink() || st.size>4096 || (process.platform!=="win32" && (st.mode & 0o077)!==0)) return fail();
    renameSync(source,claimed);
  } catch(e) { if((e as NodeJS.ErrnoException).code==="ENOENT") return undefined; return fail(); }
  try {
    const data=JSON.parse(readFileSync(claimed,"utf8")) as DiagnosticArm;
    if(!data || !/^[a-f0-9]{32}$/.test(data.id) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt > now+600000 ||
      !(data.selection==="first-half" || /^(keep|drop):[a-f0-9]{64}:\d+-\d+$/.test(data.selection)) ||
      !(data.requestSha256===null && data.selection==="first-half" || typeof data.requestSha256==="string" && /^[a-f0-9]{64}$/.test(data.requestSha256) && data.selection!=="first-half")) return fail();
    return data.expiresAt<=now ? undefined : data;
  } catch {return fail();} finally {try{unlinkSync(claimed);}catch{}}
}
/** The gateway leaves ordinary requests alone if no live arm is present. */
export function claimOptionalDiagnosticArm(directory: string, now=Date.now()): DiagnosticArm | undefined { return readArm(directory,now); }
/** Controller tests and tools may demand an active arm. */
export function claimDiagnosticArm(directory: string, now=Date.now()): DiagnosticArm { const arm=readArm(directory,now); if(!arm)throw new ResponsesInputError("Catalog bisection arm unavailable, expired or already claimed.");return arm; }
