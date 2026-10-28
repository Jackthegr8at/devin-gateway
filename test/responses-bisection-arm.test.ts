import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { controlCatalogBisection } from "../src/cli/catalog-bisection-control.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimDiagnosticArm } from "../src/responses-bisection-arm.ts";

test("arm is single use and expired or malformed records fail closed", () => {
 const dir=mkdtempSync(join(tmpdir(),"catalog-arm-")); const path=join(dir,"arm.json"); const now=Date.now();
 const put=(record:unknown)=>writeFileSync(path,JSON.stringify(record),{mode:0o600});
 try { const valid={id:"a".repeat(32),expiresAt:now+60000,selection:"first-half",requestSha256:null}; put(valid);expect(claimDiagnosticArm(dir,now)).toEqual(valid);expect(()=>claimDiagnosticArm(dir,now)).toThrow();
  put({...valid,expiresAt:now-1});expect(()=>claimDiagnosticArm(dir,now)).toThrow();
  put({...valid,expiresAt:now+600001});expect(()=>claimDiagnosticArm(dir,now)).toThrow();
  put({...valid,selection:"keep:"+"b".repeat(64)+":0-1"});expect(()=>claimDiagnosticArm(dir,now)).toThrow();
  put({...valid,selection:"keep:"+"b".repeat(64)+":0-1",requestSha256:"c".repeat(64)});expect(claimDiagnosticArm(dir,now).requestSha256).toBe("c".repeat(64));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("concurrent processes cannot claim the same arm", async () => {
 const dir=mkdtempSync(join(tmpdir(),"catalog-claim-race-"));
 try {writeFileSync(join(dir,"arm.json"),JSON.stringify({id:"a".repeat(32),expiresAt:Date.now()+60000,selection:"first-half",requestSha256:null}),{mode:0o600});
  const moduleUrl=pathToFileURL(resolve(import.meta.dir,"../src/responses-bisection-arm.ts")).href;
  const code=`import {claimDiagnosticArm} from ${JSON.stringify(moduleUrl)};try{claimDiagnosticArm(${JSON.stringify(dir)});process.exit(0)}catch{process.exit(1)}`;
  const children=[Bun.spawn([process.execPath,"-e",code],{stdout:"ignore",stderr:"ignore"}),Bun.spawn([process.execPath,"-e",code],{stdout:"ignore",stderr:"ignore"})];
  const exits=await Promise.all(children.map(p=>p.exited));expect(exits.sort()).toEqual([0,1]);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test("control operation fails closed while another controller holds the lock",()=>{
 const dir=mkdtempSync(join(tmpdir(),"catalog-control-lock-"));try{mkdirSync(join(dir,".control.lock"));expect(()=>controlCatalogBisection({op:"stop"},dir,join(dir,"safe.jsonl"))).toThrow("locked");}finally{rmSync(dir,{recursive:true,force:true});}
});
