# Trusted Desktop catalog adapter

Exactly Codex Desktop backends **0.159.2** and **0.159.0-alpha.12.1** are reviewed. Each has a separate adapter JSON selected by an explicit version map, with no ranges or nearest-version fallback. The adapter stores the runtime version, bundled-catalog source, expected `base_instructions` SHA-256 and UTF-8 byte length, plus the non-instruction model metadata needed by generated catalogs. Both preserve Devin V1 agents and shell_command metadata; newer bundled V2/unified execution defaults are not imported.

During guarded activation, the local versioned backend runs `debug models --bundled`. The selection helper captures that JSON in memory, finds the unique instruction value matching the reviewed hash and byte length, and fails closed if the runtime, value, or provenance differs. The instruction text is not stored in adapter metadata or diagnostics; the generated catalog stays in memory until the existing guarded temporary catalog is written.

Unknown runtime versions remain unsupported. The launcher fingerprint covers the adapter metadata and selection processor, so changes require a reviewed fingerprint update.
