import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";

test("opt-in complete catalog captures bounded privacy-safe ordered fingerprints", () => {
 const dir=mkdtempSync(join(tmpdir(),"full-catalog-test-"));
 const old={ mode:process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS, dir:process.env.DEVIN_RESPONSES_FULL_CATALOG_DIR, keep:process.env.DEVIN_RESPONSES_FULL_CATALOG_RETENTION };
 try {
  process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS="1"; process.env.DEVIN_RESPONSES_FULL_CATALOG_DIR=join(dir,"full"); process.env.DEVIN_RESPONSES_FULL_CATALOG_RETENTION="2";
  const make=(count:number,changed=false,reverse=false)=>{
   const tools=Array.from({length:count},(_,i)=>({name:`tool_${i}`,originalName:`tool_${i}`,namespace:"synthetic",description:"PRIVATE_DESCRIPTION",jsonSchemaString:JSON.stringify({type:"object",properties:{PRIVATE_FIELD:{type:changed&&i===200?"number":"string"}},description:"PRIVATE_SCHEMA"}),strict:false}));
   if(reverse) tools.reverse();
   const d=new ResponsesSafeDiagnostic("synthetic-request",Date.now(),join(dir,"legacy.jsonl"));d.setRequestSummary({tools,convertedMessageCount:3,convertedPromptBytes:40,convertedSystemBytes:12,instructions:"PRIVATE_PROMPT"});expect(d.finalize()).toBe(true);
   const files=readdirSync(join(dir,"full")).sort(); const records=files.map(n=>JSON.parse(readFileSync(join(dir,"full",n),"utf8")));return records.find(r=>r.catalog.entries[0].wire_name===(reverse?`tool_${count-1}`:"tool_0") && r.catalog.total===count && (changed ? r.catalog.entries.find((e:any)=>e.wire_name==="tool_200").schema_sha256!==baseHash : true)) ?? records.at(-1);
  };
  const a=make(351); const baseHash=a.catalog.entries[200].schema_sha256;
  expect(a.catalog.entries).toHaveLength(351);expect(a.catalog.truncated).toBe(false);expect(a.catalog.entries[200].ordinal).toBe(200);
  const b=make(351,true);expect(b.catalog.entries[200].schema_sha256).not.toBe(baseHash);expect(b.catalog.aggregate_sha256).not.toBe(a.catalog.aggregate_sha256);
  const c=make(351,false,true);expect(c.catalog.entries[0].wire_name).toBe("tool_350");expect(c.catalog.aggregate_sha256).not.toBe(a.catalog.aggregate_sha256);
  expect(readdirSync(join(dir,"full"))).toHaveLength(2);
  const d=make(513);expect(d.catalog.entries).toHaveLength(512);expect(d.catalog.truncated).toBe(true);
  for(const name of readdirSync(join(dir,"full"))) { const raw=readFileSync(join(dir,"full",name),"utf8");expect(raw).not.toContain("PRIVATE_DESCRIPTION");expect(raw).not.toContain("PRIVATE_SCHEMA");expect(raw).not.toContain("PRIVATE_FIELD");expect(raw).not.toContain("PRIVATE_PROMPT"); }
  process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS="0"; const n=readdirSync(join(dir,"full")).length; const off=new ResponsesSafeDiagnostic("off",Date.now(),join(dir,"legacy.jsonl"));off.setRequestSummary({tools:[]});off.finalize();expect(readdirSync(join(dir,"full"))).toHaveLength(n);
 } finally { for(const [k,v] of [["DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS",old.mode],["DEVIN_RESPONSES_FULL_CATALOG_DIR",old.dir],["DEVIN_RESPONSES_FULL_CATALOG_RETENTION",old.keep]] as const) { if(v===undefined) delete process.env[k];else process.env[k]=v; } rmSync(dir,{recursive:true,force:true}); }
});

test("309-tool catalog fingerprint is deterministic and mode is isolated", () => {
 const dir=mkdtempSync(join(tmpdir(),"catalog-determinism-")); const prevMode=process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS; const prevDir=process.env.DEVIN_RESPONSES_FULL_CATALOG_DIR;
 try {
  process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS="1"; process.env.DEVIN_RESPONSES_FULL_CATALOG_DIR=join(dir,"full");
  const tools=Array.from({length:309},(_,i)=>({name:`tool_${i}`,originalName:`tool_${i}`,jsonSchemaString:'{"type":"object"}'}));
  for(let i=0;i<2;i++){const d=new ResponsesSafeDiagnostic(`request_${i}`,Date.now(),join(dir,"legacy.jsonl"));d.setRequestSummary({tools});expect(d.finalize()).toBe(true);}
  const records=readdirSync(join(dir,"full")).map(n=>JSON.parse(readFileSync(join(dir,"full",n),"utf8")));
  expect(records).toHaveLength(2);expect(records[0].catalog.entries).toHaveLength(309);expect(records[0].catalog.aggregate_sha256).toBe(records[1].catalog.aggregate_sha256);
 } finally { if(prevMode===undefined)delete process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS;else process.env.DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS=prevMode;if(prevDir===undefined)delete process.env.DEVIN_RESPONSES_FULL_CATALOG_DIR;else process.env.DEVIN_RESPONSES_FULL_CATALOG_DIR=prevDir;rmSync(dir,{recursive:true,force:true}); }
});
