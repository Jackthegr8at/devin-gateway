/** Rejecting loopback-only Desktop probe: does not proxy, persist requests, or return tools. */
import { randomUUID } from "node:crypto";
import { responsesExecutableDeclarations, responsesInputToOpenAIMessages, responsesToolsetToDevin } from "../src/convert.js";
import { bisectionRequestFingerprint, selectBisectionCatalog } from "../src/responses-catalog-bisection.js";
import { claimOptionalDiagnosticArm } from "../src/responses-bisection-arm.js";

export type MockResult = { request_id: string; outcome: string; original_count?: number; selected_count?: number; catalog_sha256?: string; request_sha256?: string; mode?: string; ordinals?: number[] };
export async function desktopMockResponse(req: Request, record: (result: MockResult) => void): Promise<Response> {
  const requestId = randomUUID().slice(0,8);
  const pathname = new URL(req.url).pathname;
  if (req.method === "GET" && pathname === "/v1/models") return Response.json({data:[{id:"claude-haiku-5-5",object:"model",owned_by:"local-mock"}]});
  if (req.method !== "POST" || pathname !== "/v1/responses") return new Response(null,{status:404});
  try {
    const body = await req.json() as any;
    const full=responsesToolsetToDevin(responsesExecutableDeclarations(body.tools,body.input));
    const messages=responsesInputToOpenAIMessages(body.input);
    const eligible=body.model==="claude-haiku-5-5" && body.reasoning?.effort==="high";
    const arm=eligible ? claimOptionalDiagnosticArm(process.env.DEVIN_RESPONSES_CATALOG_BISECTION_DIR ?? "") : undefined;
    if(!arm) {record({request_id:requestId,outcome:eligible?"unarmed":"not_eligible"});return Response.json({error:{message:"Local diagnostic mock rejected request",type:"invalid_request_error"}},{status:400});}
    const requestHash=bisectionRequestFingerprint(body);
    if (arm?.requestSha256 && arm.requestSha256 !== requestHash) throw new Error("request mismatch");
    const selected=selectBisectionCatalog(full,arm.selection,{enabled:true,diagnosticsEnabled:true,guardian:req.headers.get("x-openai-subagent")==="guardian" || req.headers.get("x-codex-guardian")==="reviewer" || (body.client_metadata !== null && typeof body.client_metadata === "object" && !Array.isArray(body.client_metadata) && body.client_metadata["x-openai-subagent"] === "guardian"),legacySelector:req.headers.has("x-devin-diagnostic-tool-catalog"),model:body.model,effort:body.reasoning?.effort,messages,toolChoice:body.tool_choice});
    record({request_id:requestId,outcome:"selected_and_rejected",original_count:full.tools.length,selected_count:selected.toolset.tools.length,catalog_sha256:selected.fingerprint,request_sha256:requestHash,mode:selected.mode,ordinals:selected.ordinals});
  } catch { record({request_id:requestId,outcome:"invalid_or_unsafe_request"}); }
  // Never emit a Responses tool call or completion; Desktop cannot execute tools from this response.
  return Response.json({error:{message:"Local diagnostic mock: request intentionally rejected",type:"invalid_request_error"}},{status:400});
}

if (import.meta.main) {
  const port=process.env.DEVIN_DESKTOP_MOCK_PORT === undefined ? 0 : Number(process.env.DEVIN_DESKTOP_MOCK_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local mock port");
  const server=Bun.serve({hostname:"127.0.0.1",port,maxRequestBodySize:8*1024*1024,fetch(req) {return desktopMockResponse(req,result=>process.stdout.write(JSON.stringify(result)+"\n"));}});
  process.stdout.write(JSON.stringify({event:"local_mock_ready",base_url:`${server.url.origin}/v1`,forwarding:false})+"\n");
}
