import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopMockResponse, type MockResult } from "../scripts/desktop-catalog-mock.ts";
const body={model:"claude-haiku-5-5",reasoning:{effort:"high"},instructions:"PRIVATE_PROMPT",input:"PRIVATE_USER",tool_choice:"auto",tools:[{type:"function",name:"one",description:"PRIVATE_DESCRIPTION",parameters:{type:"object"}},{type:"function",name:"two",parameters:{type:"object"}}]};
test("one mock process selects successive arms without headers or private output",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"desktop-mock-arm-"));const prior=process.env.DEVIN_RESPONSES_CATALOG_BISECTION_DIR;process.env.DEVIN_RESPONSES_CATALOG_BISECTION_DIR=dir;
 const arm=(selection:string,requestSha256:string|null)=>writeFileSync(join(dir,"arm.json"),JSON.stringify({id:"a".repeat(32),expiresAt:Date.now()+60000,selection,requestSha256}),{mode:0o600});
 const send=async(data:unknown=body)=>{const records:MockResult[]=[];const response=await desktopMockResponse(new Request("http://127.0.0.1/v1/responses",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(data)}),r=>records.push(r));return {response,records};};
 try {arm("first-half",null);const first=await send();expect(first.records[0]).toMatchObject({outcome:"selected_and_rejected",original_count:2,selected_count:1,ordinals:[0]});const f=first.records[0].catalog_sha256!,h=first.records[0].request_sha256!;
  arm(`keep:${f}:1-1`,h);expect((await send()).records[0].ordinals).toEqual([1]);expect((await send()).records[0].outcome).toBe("unarmed");
  arm(`keep:${f}:0-0`,h);expect((await send({...body,model:"swe-2"})).records[0].outcome).toBe("not_eligible");
  expect((await send({...body,input:"changed"})).records[0].outcome).toBe("invalid_or_unsafe_request");
  for(const value of ["PRIVATE_PROMPT","PRIVATE_USER","PRIVATE_DESCRIPTION"])expect(JSON.stringify(first.records)).not.toContain(value);
 } finally {if(prior===undefined)delete process.env.DEVIN_RESPONSES_CATALOG_BISECTION_DIR;else process.env.DEVIN_RESPONSES_CATALOG_BISECTION_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});
