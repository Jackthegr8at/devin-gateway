# Model validation status

The picker records status for exact concrete variants, independently of enabled models, role assignments and the selection revision. Nothing is inferred from old logs or bundled compatibility profiles. Existing variants start Untested until a new completed tool validation or deliberate manual mark.

## Automatic evidence

The gateway correlates a completed, validated emitted tool call with a later function_call_output in memory. Correlation requires the same hashed credential scope, concrete model, requested effort and call ID. The continuation must have upstream HTTP 200, upstream completion, response completion and no failure classification. Replayed assistant history cannot establish an issued call. Pending IDs expire after one hour and are limited to 1,024; restart discards pending evidence, not saved status.

Responses has no universal local tool success flag. Only an explicit zero exit code in a structured result or the native Codex terminal command envelope, or a structured success status without an error, qualifies. Opaque output, nonzero exit, running sessions and text-only responses remain Untested. No tool arguments or output are retained. This proves reported client-side success, not independent execution by the gateway; the gateway still executes no commands.

Safe JSONL retains existing routing fields and adds had_tool_call and had_function_call_output booleans. The first describes validated emitted calls, not history. The second describes current request output items. All existing error classifications remain diagnostic-only. In-process status collection works without enabling JSONL and suppresses raw Responses tracing.

Routing identifiers come from completed gateway model resolution. Emitted calls come from the same finished, validated accumulator used by the Responses bridge; returned calls come from the Responses converter's normalized tool messages. These structured paths reject credentials and malformed identifiers, but do not discard a valid ID merely because Desktop history or a tool schema mentions it. Arbitrary trace/error fields retain the stricter sensitive-text substring check. Matching uses the exact credential scope, call ID, resolved variant and requested effort across separate requests; the two evidence booleans need not both be true on one request.

## Manual marks and persistence

Use Mark tested / Mark untested on the exact variant row (for example SWE-2 Medium, High and Max). Marks save immediately; Save/Cancel applies only to selection drafts. The buttons never change enabled state or roles. The compact status badge tooltip reports manual/automatic provenance and the last automatic success timestamp when available.

Manual overrides are authoritative, including Mark untested. Future automatic evidence is retained separately but does not override a manual decision. A later transient inference failure never clears saved Tested status. Refresh/reopen the picker to obtain external updates or resolve a status ETag conflict.

Private settings file: model-test-status.json in the existing settings directory/volume, separate from OAuth and model-selection.json. Atomic writes use a 0600 temporary file and rename; the directory is 0700 on Linux. Corrupt state fails closed and is not silently reseeded. Its own revision/ETag handles competing status writers; selection revision is unaffected.

```json
{
  "schemaVersion": 1,
  "revision": 2,
  "variants": {
    "swe-2-high": {
      "automatic": {
        "source": "automatic",
        "lastSuccessAt": "2026-10-02T12:00:00.000Z",
        "logicalModel": "swe-2",
        "effort": "high"
      },
      "manual": {
        "source": "manual",
        "status": "tested",
        "updatedAt": "2026-10-02T12:01:00.000Z"
      }
    }
  }
}
```

The example is synthetic. No script, instruction text or credential belongs in this file.

Management-only API:

- GET /admin/api/model-test-status returns the private status data and ETag.
- PUT /admin/api/model-test-status accepts exactly modelId and status, with application/json, x-devin-management: 1 and If-Match. A stale ETag returns 412.
- GET /admin/api/models merges effective status into the variant rows and supplies testStatusETag.

Existing Host/Origin/CSRF guards and the loopback-published management listener apply. These routes are never exposed on the inference listener. Codex selection export remains based on enabled + available + structurally compatible, never Tested gating.
