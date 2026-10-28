import { describe, expect, test } from "bun:test";
import { foldDevinToolSchema } from "../src/devin-schema-fold.js";

describe("Devin root union folding", () => {
  test("keeps schemas without root unions byte-for-byte, including nested unions", () => {
    const raw=' { "type": "object", "properties": {"x":{"anyOf":[{"type":"string"},{"type":"null"}]}} } ';
    expect(foldDevinToolSchema(raw)).toBe(raw);
  });
  test("folds automation_update-style references and nested unions, preserving required fields", () => {
    const source={type:"object",properties:{id:{type:"string"}},required:["id"],$defs:{create:{type:"object",properties:{mode:{const:"create"},project:{type:"string"}},required:["mode","project"]}, update:{type:"object",properties:{mode:{const:"update"},project:{type:"string"}},required:["mode","project"]}},allOf:[{type:"object",properties:{kind:{type:"string"}},required:["kind"]}],oneOf:[{anyOf:[{$ref:"#/$defs/create"},{$ref:"#/$defs/update"}]},{type:"object",properties:{mode:{const:"delete"},project:{type:"string"}},required:["mode","project"]}]};
    const out=JSON.parse(foldDevinToolSchema(JSON.stringify(source)));
    expect(out.oneOf).toBeUndefined();expect(out.allOf).toBeUndefined();expect(out.type).toBe("object");expect(out.required).toEqual(["id","kind","mode","project"]);expect(out.properties.mode.anyOf).toHaveLength(2);expect(out.$defs).toEqual(source.$defs);
  });
  test("folds anyOf and retains only common branch requirements", () => {
    const out=JSON.parse(foldDevinToolSchema(JSON.stringify({anyOf:[{type:"object",properties:{a:{type:"string"},shared:{type:"string"}},required:["a","shared"]},{type:"object",properties:{b:{type:"number"},shared:{type:"string"}},required:["b","shared"]}]})));
    expect(out.required).toEqual(["shared"]);expect(Object.keys(out.properties).sort()).toEqual(["a","b","shared"]);
  });
  test("rejects unresolved references instead of silently dropping a branch", () => {
    expect(()=>foldDevinToolSchema(JSON.stringify({oneOf:[{$ref:"#/$defs/missing"}]}))).toThrow("Unresolved");
  });
});
