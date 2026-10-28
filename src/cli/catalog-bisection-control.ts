/** SSH-invoked local control: only sanitized metadata crosses the operator connection. */
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, linkSync, readSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type DiagnosticArm } from "../responses-bisection-arm.js";

export function controlCatalogBisection(value: any, dir: string, log: string, now=Date.now()): unknown {
 if (!value || typeof value !== "object") throw new Error("invalid operation");
 mkdirSync(dir,{recursive:true,mode:0o700}); const st=lstatSync(dir);
 if (!st.isDirectory() || st.isSymbolicLink() || (process.platform!=="win32" && (st.mode & 0o077)!==0)) throw new Error("unsafe control directory");
 const file=join(dir,"arm.json"), lock=join(dir,".control.lock");
 try { mkdirSync(lock,{mode:0o700}); } catch { throw new Error("control is locked"); }
 try {
 if(value.op === "arm") {
  const a=value.arm as DiagnosticArm;
  if(!a || !/^[a-f0-9]{32}$/.test(a.id) || !Number.isSafeInteger(a.expiresAt) || a.expiresAt<=now || a.expiresAt>now+600000 || !(a.selection === "first-half" && a.requestSha256 === null || /^(keep|drop):[a-f0-9]{64}:\d+-\d+$/.test(a.selection) && typeof a.requestSha256 === "string" && /^[a-f0-9]{64}$/.test(a.requestSha256))) throw new Error("invalid arm");
  if(existsSync(file)) { try {const previous=lstatSync(file);if(!previous.isFile() || previous.isSymbolicLink() || previous.size>4096 || (process.platform!=="win32" && (previous.mode & 0o077)!==0)) throw new Error("unsafe arm");const old=JSON.parse(readFileSync(file,"utf8"));if(Number.isSafeInteger(old.expiresAt) && old.expiresAt<=now) unlinkSync(file);else throw new Error("arm exists");} catch {throw new Error("arm exists or invalid");} }
  const tmp=join(dir,`.arm-${randomUUID()}.tmp`); const fd=openSync(tmp,"wx",0o600);
  try {writeFileSync(fd,JSON.stringify(a)+"\n");} finally {closeSync(fd);}
  try {linkSync(tmp,file);} finally {unlinkSync(tmp);} return {armed:true,arm_id:a.id,expires_at:a.expiresAt};
 }
 if(value.op === "clear-expired") {
  if (!/^[a-f0-9]{32}$/.test(value.id)) throw new Error("invalid id");
  const st=lstatSync(file);if(!st.isFile() || st.isSymbolicLink() || st.size>4096 || (process.platform!=="win32" && (st.mode & 0o077)!==0))throw new Error("unsafe arm");
  const arm=JSON.parse(readFileSync(file,"utf8"));if(arm.id!==value.id || !Number.isSafeInteger(arm.expiresAt) || arm.expiresAt>now)throw new Error("arm is not the expected expired arm");
  unlinkSync(file);return {cleared:true};
 }
 if(value.op === "stop") { try { unlinkSync(file); } catch(e) {if((e as NodeJS.ErrnoException).code!=="ENOENT") throw e;} return {stopped:true}; }
 if(value.op === "read") {
  if(!/^[a-f0-9]{32}$/.test(value.id))throw new Error("invalid id");
  let stat; try { stat=lstatSync(log); } catch(e) { if((e as NodeJS.ErrnoException).code==="ENOENT") return {record:null}; throw e; }
  if(!stat.isFile() || stat.isSymbolicLink()) throw new Error("diagnostic log unavailable");
  const length=Math.min(stat.size,8*1024*1024), offset=stat.size-length, bytes=Buffer.alloc(length);const fd=openSync(log,"r");try {readSync(fd,bytes,0,length,offset);} finally {closeSync(fd);}
  const text=bytes.toString("utf8"), lines=(offset?text.slice(text.indexOf("\n")+1):text).split("\n");
  const matches=lines.flatMap(line=>{try {const x=JSON.parse(line);if(x.bisection_arm_id!==value.id)return [];return [{request_id:x.request_id,terminal_status:x.responses_terminal_status,upstream_terminal_status:x.upstream_terminal_status,connect_error_code:x.connect_error_code,catalog_sha256:x.bisection_catalog_sha256,request_sha256:x.bisection_request_sha256,original_count:x.original_tool_count,mode:x.bisection_mode,ordinals:x.bisection_ordinals,tool_calls:x.responses_tool_call_emitted_count,upstream_tool_calls:x.upstream_toolcall_event_count,stream_opened:x.upstream_stream_opened,http_statuses:x.upstream_http_statuses,context_mismatch:x.bisection_context_mismatch,failure_classification:x.failure_classification}];} catch {return [];}});
  if(matches.length>1)throw new Error("ambiguous diagnostic records");return {record:matches[0] ?? null};
 }
 throw new Error("unknown operation");
 } finally {rmdirSync(lock);}
}
if(import.meta.main) {
 try {let input="";for await (const chunk of process.stdin) {input+=chunk.toString();if(input.length>8192)throw new Error("input too large");}
  const result=controlCatalogBisection(JSON.parse(input),process.env.DEVIN_RESPONSES_CATALOG_BISECTION_DIR ?? "/app/logs/catalog-bisection",process.env.DEVIN_RESPONSES_SAFE_DIAGNOSTICS_PATH ?? "/app/logs/responses-safe-diagnostic.jsonl");process.stdout.write(JSON.stringify(result)+"\n");
 }catch{process.stderr.write("catalog bisection control failed\n");process.exitCode=1;}
}
