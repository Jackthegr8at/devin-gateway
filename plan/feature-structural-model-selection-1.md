# Structural model selection

Status: implemented and validated offline; uncommitted pending review.

## Approved boundaries

Replace candidate/live-review gating with available, enabled, structurally eligible
model exports. Preserve persisted schema-v2 selections, explicit roles, authoritative
family routes, authentication, security/restore guards, and the existing collapse
allowlist. Runtime instructions remain locally sourced and hash verified.

## Work

- [x] Separate tested history from structural eligibility.
- [x] Export enabled variants grouped by authoritative family metadata.
- [x] Allow enabled structural variants in role assignments.
- [x] Remove candidate-only parameters and merge/export paths.
- [x] Keep routing diagnostics metadata-only.
- [x] Distinguish HTTP selection failures from bounded discovery timeouts.
- [x] Complete regression, PowerShell, typecheck, build and privacy checks.
- [x] Review and refresh the canonical source fingerprint without weakening it.

Full Bun suite: 432 passing, 18 skipped; the sole failure is the documented
Windows SIGTERM baseline test. All seven PowerShell suites pass, as do syntax,
typechecks, production build, diff whitespace and changed-file privacy checks.

## Operational constraints

No live inference, OAuth, Desktop launch, deployment, commit or push. Discovery is
not proof of provider callability. System collapse remains limited to the existing
two concrete IDs; support for more models requires a separate decision.
