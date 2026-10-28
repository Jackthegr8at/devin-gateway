# Trusted Desktop catalog adapter

`codex-contract-1.json` describes our compatibility expectations independently of backend release. It contains only the reviewed instruction hash/UTF-8 length and generated-model metadata, never an instruction body. Backend version is detected and recorded but is not an allowlist authority. There are no ranges, nearest-version guesses or changed-content fallbacks.

Before mutation, the managed backend runs bounded offline probes in disposable homes. Exactly one `base_instructions` value must match the unchanged reviewed hash/length. Zero matches rejects as instruction_source_unrecognized; multiple matches rejects as instruction_source_ambiguous. Changed wording still needs explicit review. The extracted value is inserted unchanged into generated entries. No instruction body is committed or logged.

The backend must accept generated IDs, exact efforts/defaults, V1 and all consumed metadata. Only the reviewed shell_command/unified_exec normalization is accepted, with complete effective equality; disabled must remain disabled. Probe config/worker bytes must stay unchanged. Contract version, backend version, executable hash and instruction hash/length enter recovery metadata. The launcher fingerprint still covers metadata and processors; its guard is not bypassed. No known-bad release denylist is currently needed.
