import {expect,test} from "bun:test";
import {spawnSync} from "node:child_process";
import {readFileSync,existsSync} from "node:fs";
import {resolve} from "node:path";
const wrapper=resolve(import.meta.dir,"../deploy/operator/Deploy-HaikuCatalogBisection.ps1");
test.if(existsSync(resolve(import.meta.dir,"../deploy/operator/Invoke-DevinDeploy.ps1")))("wrapper generates guarded cutover and baseline rollback without contacting production",()=>{
 const r=spawnSync("pwsh",["-NoProfile","-File",wrapper,"-TargetCommit","f8168bc941e83df196eb37f20b1d94d9b092177d","-BundleRef","codex/write-stdin-description","-ValidateOnly"],{encoding:"utf8"});
 expect(r.status).toBe(0);expect(r.stdout).toContain("generated cutover and rollback guards");
 const s=readFileSync(wrapper,"utf8");expect(s).toContain("$baseline = 'f8168bc941e83df196eb37f20b1d94d9b092177d'");expect(s).toContain("assert c['Image']=='$image'");expect(s).toContain("DEVIN_RESPONSES_CATALOG_BISECTION=1");expect(s).toContain("assert e.get('DEVIN_RESPONSES_CATALOG_BISECTION') in [None,'0']");
});

test.if(existsSync(resolve(import.meta.dir,"../deploy/operator/Invoke-DevinDeploy.ps1")))("fingerprint wrapper preserves the enabled diagnostic baseline on rollback",()=>{
 const fix=resolve(import.meta.dir,"../deploy/operator/Deploy-HaikuFingerprintFix.ps1");
 const r=spawnSync("pwsh",["-NoProfile","-File",fix,"-TargetCommit","e3d35c558f2a2b3f24532627bf0dbac05c31b610","-BundleRef","codex/write-stdin-description","-ValidateOnly"],{encoding:"utf8"});
 expect(r.status).toBe(0);expect(r.stdout).toContain("generated cutover and rollback guards");const s=readFileSync(fix,"utf8");expect(s).toContain("$baseline = 'e3d35c558f2a2b3f24532627bf0dbac05c31b610'");expect(s).toContain("assert e.get('DEVIN_RESPONSES_CATALOG_BISECTION')=='1'");expect(s).toContain("$baselineCommand = \"    'sudo -n env DEVIN_RESPONSES_CATALOG_BISECTION=1");
});
