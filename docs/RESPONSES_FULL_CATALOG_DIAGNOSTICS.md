# Opt-in complete catalog fingerprints

This diagnostic is off by default and requires the existing safe Responses diagnostic
facility (`DEVIN_RESPONSES_SAFE_DIAGNOSTICS=1`) as well as
`DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS=1`. Set these only in a separately approved
operator deployment. No request header enables this mode.

The default separate output directory is `full-catalog` beside the existing safe
JSONL log; override with `DEVIN_RESPONSES_FULL_CATALOG_DIR`. It must be private to
the gateway operator. On POSIX the writer sets the directory mode to 0700 and creates
files mode 0600. Windows mode bits do not enforce Windows ACLs: operators must
preconfigure a restrictive directory ACL, so Windows privacy is not automatically
verified. Avoid shared, public, network-mounted or symlinked directories.

`DEVIN_RESPONSES_FULL_CATALOG_RETENTION` sets a count from 1 to 200 (default 20).
Only files matching the diagnostic's own `catalog-<timestamp>-<uuid>.json` pattern
are removed, oldest filename first. This is count-based, not age-based; record
retention also depends on request volume. Recommend 20 for a short controlled
investigation and remove records through the operator's approved procedure afterward.

Each separate JSON file carries the gateway request ID, sanitized routing and request
settings, normalized message counts, text byte counts, and a catalog object. For up to
512 tools it records ordinal, sanitized wire/namespace/function names, identity hashes,
description/schema hashes and byte lengths, strictness, and bounded schema-keyword
counts. The aggregate hash covers the captured ordered entries. A catalog over 512 is
explicitly marked incomplete; so is a truncated per-schema structure analysis.
`identities_redacted` indicates identifiers that did not pass existing safety checks.
Neither descriptions, schemas, prompt text, arguments, credentials nor message history
are written. Schema keyword counts do not reveal arbitrary schema property names.

Converted prompt bytes count prompt text only; tool argument JSON, images, hidden
provider state and token occupancy are not measured. A maximum 1 MiB serialized
record limit prevents oversized output; an oversized record is replaced with a bounded summary marked size_limit_reached. On a write failure the catalog file may
be absent; the legacy diagnostic record remains subject to its existing behavior.
Diagnostic write errors never change inference. Records do not reconstruct old
requests that were logged with the previous 64-tool cap.

Rollback: disable `DEVIN_RESPONSES_FULL_CATALOG_DIAGNOSTICS` and restart through the
existing approved operator procedure, or revert the code change through the reviewed
release process. Existing diagnostic files remain until removed under an approved
retention procedure. No setting was changed or service restarted by this task.
