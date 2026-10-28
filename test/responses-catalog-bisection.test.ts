import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesToolsetToDevin } from "../src/convert.ts";
import { bisectionRequestFingerprint, catalogBisectionFingerprint, selectBisectionCatalog } from "../src/responses-catalog-bisection.ts";
import { ResponsesSafeDiagnostic } from "../src/responses-diagnostics.ts";

const declarations = Array.from({ length: 351 }, (_, i) => ({ type: "function", name: `tool_${i}`, description: `PRIVATE_DESCRIPTION_${i}`, strict: i % 2 === 0, parameters: { type: "object", properties: { private_field: { type: "string" } } } }));
const catalog = () => responsesToolsetToDevin(declarations);
const opts = () => ({ enabled: true, model: "claude-haiku-5-5", effort: "high", guardian: false, legacySelector: false, messages: [{ role: "user" as const, content: "PRIVATE_PROMPT" }], toolChoice: "auto", diagnosticsEnabled: true });

test("observe and deterministic keep/drop retain exact original objects, identities and order", () => {
  const full = catalog(); const fingerprint = catalogBisectionFingerprint(full);
  expect(selectBisectionCatalog(full, "observe", opts()).toolset).toBe(full);
  const a = selectBisectionCatalog(full, `keep:${fingerprint}:0-174`, opts());
  const b = selectBisectionCatalog(full, `drop:${fingerprint}:0-174`, opts());
  expect(a.ordinals).toEqual(Array.from({length:175},(_,i)=>i));
  expect(b.ordinals).toEqual(Array.from({length:176},(_,i)=>i+175));
  expect([...a.toolset.tools,...b.toolset.tools]).toEqual(full.tools);
  expect(a.toolset.tools[0]).toBe(full.tools[0]);
  expect(a.toolset.identities.get(full.tools[0].name)).toBe(full.identities.get(full.tools[0].name));
  expect(a.toolset.identities.has(full.tools[200].name)).toBe(false);
  expect(catalogBisectionFingerprint(full)).toBe(fingerprint);
});

test("pin detects description, schema, identity and order drift", () => {
  const full = catalog(); const fingerprint = catalogBisectionFingerprint(full);
  const changed = responsesToolsetToDevin(declarations.map((d,i)=>i===250 ? {...d, description: "different"} : d));
  expect(() => selectBisectionCatalog(changed, `keep:${fingerprint}:0-100`, opts())).toThrow("fingerprint mismatch");
  expect(catalogBisectionFingerprint(responsesToolsetToDevin([...declarations].reverse()))).not.toBe(fingerprint);
  const schema = responsesToolsetToDevin(declarations.map((d,i)=>i===300 ? {...d, parameters:{type:"object"}} : d));
  expect(catalogBisectionFingerprint(schema)).not.toBe(fingerprint);
  const renamed = responsesToolsetToDevin(declarations.map((d,i)=>i===300 ? {...d, name:"different"} : d));
  expect(catalogBisectionFingerprint(renamed)).not.toBe(fingerprint);
});

test("fail closed for disabled, other models, reviewer, unsafe request semantics, and invalid ranges", () => {
  const full = catalog(); const f = catalogBisectionFingerprint(full); const selection = `keep:${f}:0-10`;
  for (const patch of [{enabled:false}, {diagnosticsEnabled:false}, {model:"swe-2"}, {effort:"medium"}, {guardian:true}, {legacySelector:true}, {toolChoice:"required"}, {toolChoice:{type:"function", name:"tool_0"}}, {messages:[{role:"tool" as const, content:"PRIVATE_OUTPUT", tool_call_id:"call"}]}, {messages:[{role:"assistant" as const, content:"", tool_calls:[{id:"call",type:"function" as const,function:{name:"tool_0",arguments:"{}"}}]}]}]) {
    expect(() => selectBisectionCatalog(full, selection, {...opts(), ...patch})).toThrow();
  }
  for(const value of [`keep:${f}:10-9`, `keep:${f}:0-351`, `drop:${f}:0-350`, `keep:${"0".repeat(64)}:0-2`, "keep:bad:0-1"]) expect(() => selectBisectionCatalog(full, value, opts())).toThrow();
});

test("safe persisted selection is bounded numeric metadata and contains no private material", () => {
 const dir=mkdtempSync(join(tmpdir(),"bisection-"));
 try { const full=catalog();const f=catalogBisectionFingerprint(full);const selected=selectBisectionCatalog(full,`keep:${f}:10-20`,opts());const path=join(dir,"log.jsonl");const d=new ResponsesSafeDiagnostic("synthetic",Date.now(),path);d.recordBisectionSelection(full.tools.length,f,"a".repeat(64),selected.mode,selected.ordinals);d.setRequestSummary({instructions:"PRIVATE_PROMPT",tools:selected.toolset.tools.map(t=>({name:t.name,originalName:selected.toolset.identities.get(t.name)!.name,description:t.description,jsonSchemaString:t.jsonSchemaString,strict:t.strict}))});expect(d.finalize()).toBe(true);const raw=readFileSync(path,"utf8");const data=JSON.parse(raw);expect(data.bisection_catalog_sha256).toBe(f);expect(data.bisection_ordinals).toEqual(selected.ordinals);expect(data.original_tool_count).toBe(351);for(const secret of ["PRIVATE_PROMPT","PRIVATE_DESCRIPTION","private_field"])expect(raw).not.toContain(secret); } finally {rmSync(dir,{recursive:true,force:true});}
});


test("only the verified visualization UUID in both Codex context blocks is normalized",()=>{
 const root=(id:string)=>`C:\\Users\\Jack\\.codex\\visualizations\\2026\\10\\27\\${id}`;
 const a="01a18018-1246-7290-a6f4-0b95fe688617",b="01a18018-c34b-77f2-a345-abb9b3c48430";
 const make=(id:string)=>({model:"claude-haiku-5-5",reasoning:{effort:"high"},tools:[{name:"ignored"}],input:[
  {role:"developer",content:[{type:"input_text",text:`<permissions instructions>workspace: \`${root(id)}\`</permissions instructions>`}]},
  {role:"user",content:[{type:"input_text",text:`<environment_context><path>${root(id)}</path></environment_context>`}]},
  {role:"user",content:[{type:"input_text",text:"Reply with OK only."}]}]});
 const x=make(a),y=make(b),original=JSON.stringify(x);expect(bisectionRequestFingerprint(x)).toBe(bisectionRequestFingerprint(y));expect(JSON.stringify(x)).toBe(original);
 const prompt=make(b);prompt.input[2].content[0].text="Different task";expect(bisectionRequestFingerprint(x)).not.toBe(bisectionRequestFingerprint(prompt));
 const policy=make(b);policy.input[0].content[0].text+=" changed policy";expect(bisectionRequestFingerprint(x)).not.toBe(bisectionRequestFingerprint(policy));
 const dated=make(b);for(const item of dated.input)for(const part of item.content)part.text=part.text.replace("2026","2027");expect(bisectionRequestFingerprint(x)).not.toBe(bisectionRequestFingerprint(dated));
 const other=make(b);other.input[2].content[0].text=root(b);expect(bisectionRequestFingerprint(x)).not.toBe(bisectionRequestFingerprint(other));
 const mixed=make(b);mixed.input[1].content[0].text=mixed.input[1].content[0].text.replace(b,a);expect(bisectionRequestFingerprint(x)).not.toBe(bisectionRequestFingerprint(mixed));
 const effort=make(b);effort.reasoning.effort="medium";expect(bisectionRequestFingerprint(x)).not.toBe(bisectionRequestFingerprint(effort));
});


test("verified Codex message IDs and consistent session metadata do not mask meaningful settings",()=>{
 const build=(id:string,window:string,time:number)=>({model:"claude-haiku-5-5",reasoning:{effort:"high"},prompt_cache_key:id,client_metadata:{session_id:id,thread_id:id,turn_id:id,root_turn_id:id,"x-codex-window-id":window,"x-codex-turn-metadata":JSON.stringify({session_id:id,thread_id:id,turn_id:id,root_turn_id:id,window_id:window,context_window_id:id,turn_started_at_unix_ms:time,sandbox:"restricted",model:"claude-haiku-5-5",reasoning_effort:"high",request_kind:"normal"})},input:[{type:"message",role:"user",id:`msg_${id}`,content:[{type:"input_text",text:"Synthetic task"}]}]});
 const a=build("01a18018-1246-7290-a6f4-0b95fe688617","window-one",100),b=build("01a18018-c34b-77f2-a345-abb9b3c48430","window-two",200);
 expect(bisectionRequestFingerprint(a)).toBe(bisectionRequestFingerprint(b));
 const altered=build("01a18018-c34b-77f2-a345-abb9b3c48430","window-two",200);const turn=JSON.parse(altered.client_metadata["x-codex-turn-metadata"]);turn.sandbox="unrestricted";altered.client_metadata["x-codex-turn-metadata"]=JSON.stringify(turn);expect(bisectionRequestFingerprint(a)).not.toBe(bisectionRequestFingerprint(altered));
 const cache=build("01a18018-c34b-77f2-a345-abb9b3c48430","window-two",200);cache.prompt_cache_key="explicit-custom-cache";expect(bisectionRequestFingerprint(a)).not.toBe(bisectionRequestFingerprint(cache));
 const inconsistent=build("01a18018-c34b-77f2-a345-abb9b3c48430","window-two",200);inconsistent.client_metadata.root_turn_id="01a18018-1246-7290-a6f4-0b95fe688617";expect(bisectionRequestFingerprint(a)).not.toBe(bisectionRequestFingerprint(inconsistent));
 const arbitrary=build("01a18018-c34b-77f2-a345-abb9b3c48430","window-two",200);arbitrary.input[0].id="external-id";expect(bisectionRequestFingerprint(a)).not.toBe(bisectionRequestFingerprint(arbitrary));
 const extra=build("01a18018-c34b-77f2-a345-abb9b3c48430","window-two",200);(extra.client_metadata as Record<string,string>).new_setting="changed";expect(bisectionRequestFingerprint(a)).not.toBe(bisectionRequestFingerprint(extra));
});

test("request fingerprints ignore JSON object key order but preserve array order",()=>{
 const a={model:"claude-haiku-5-5",reasoning:{effort:"high",summary:"auto"},input:[{role:"user",content:"first"},{role:"user",content:"second"}]};
 const b={input:[{content:"first",role:"user"},{content:"second",role:"user"}],reasoning:{summary:"auto",effort:"high"},model:"claude-haiku-5-5"};
 expect(bisectionRequestFingerprint(a)).toBe(bisectionRequestFingerprint(b));expect(bisectionRequestFingerprint(a)).not.toBe(bisectionRequestFingerprint({...b,input:[...b.input].reverse()}));
});
