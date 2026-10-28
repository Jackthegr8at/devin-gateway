# One controlled Memory catalog test

`POST /v1/responses` accepts the diagnostic header
`x-devin-diagnostic-tool-catalog: memory-only`. This is a request-local opt-in,
not a global setting. No header means no catalog changes. Unknown selections
fail with HTTP 400. Do not add this header to the normal provider configuration.

All top-level and `additional_tools` declarations are merged and validated first.
The final executable catalog retains exactly the six `mcp__memory` functions
(`associate_memories`, `check_database_health`, `delete_memory`, `recall_memory`,
`store_memory`, `update_memory`).
Flat `mcp__memory__<function>` identities are also recognized without renaming.
Missing or ambiguous Memory declarations fail before generation. Other
unsupported declaration types still fail validation. No other tool is needed
for the Memory call/result round trip. `exec_command` is not technically needed
and is excluded for this diagnostic; normal requests retain it unchanged.

Schemas, strict flags, original identities and call/result IDs are unchanged.
Excluded historical calls become inert through the existing history conversion.
The model receives an explicit diagnostic-catalog notice. New calls must match
the reduced catalog; excluded/unknown names are rejected, never executed or
remapped. Codex still executes MCP calls with its normal approval/security
controls. Guardian reviewers ignore an inherited diagnostic header and keep
their existing behavior; their catalogs are not part of the isolation test.

Safe diagnostics record `diagnostic_tool_catalog: memory-only`,
`original_tool_count`, and the actual final `tool_count` (exactly 6).
All selected tools fit inside the 64-entry structural diagnostic budget.

## Operator steps

1. Deploy the reviewed commit with its guarded wrapper after closing Codex.
   Keep the manifest and the exact rollback command. No Nginx or environment
   changes are required.
2. Open **one fresh, temporary Codex CLI session**, using the command below.
   Its inline provider configuration is process-local; it does not write
   `config.toml`, change the normal Desktop provider, or configure MCP credentials.
   It uses the existing gateway's active account and Codex's already-configured
   MCP servers. If those Memory declarations are absent in CLI, the explicit
   HTTP 400 is a setup failure, not an upstream catalog-isolation result.

   ```powershell
   codex -m swe-2 -c 'model_provider="memory_isolation"' -c 'model_providers.memory_isolation={name="Memory catalog isolation",base_url="http://<gateway-host>:38643/v1",wire_api="responses",http_headers={"x-devin-diagnostic-tool-catalog"="memory-only"}}'
   ```

3. Send exactly one user task:

   > Use the configured Memory MCP recall_memory function to retrieve my network
   > infrastructure information. Use MCP directly; do not use exec_command,
   > HTTP APIs, or inspect credentials. After Codex executes the call, summarize
   > the returned information and identify the executed tool. If unavailable,
   > report that explicitly. Do not store, update, associate or delete memories.

4. Allow the normal Codex approval flow and tool-result continuation. The same
   process-local header applies to both requests. Do not retry if generation
   fails. Exit the temporary CLI session when finished.
5. Inspect only safe diagnostics for this attempt. Require the isolation marker
   and final count 6 before interpreting it. Guardian/helper requests are
   separate; their result is not evidence that the Memory call succeeded.

## Interpretation

- A `recall_memory` call returned to Codex, executed by Codex, followed by a
  summary based on the result proves the minimal catalog works end to end.
  It implicates some difference in the larger catalog, but does not identify
  which tool/schema or prove a numeric tool limit. Do not trim normal requests.
- The same `permission_denied` / `MCP configuration issue` with a verified six-tool
  catalog shows that catalog reduction alone does not resolve the rejection.
  Stop; do not change schemas or tool identities based on that result alone.
- Text without an executed MCP call is not a successful MCP test. A Codex-side
  MCP execution failure after a valid returned call isolates a client/MCP issue
  from the earlier upstream generation rejection.

No deployment or live inference is performed by the implementation tests.
