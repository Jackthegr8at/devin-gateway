# Local operator configuration and publication

The gateway runtime reads its ignored `.env` as documented in `.env.example`.
PowerShell does not load `.env` automatically. Copy
`deploy/operator/operator-config.example.ps1` to
`deploy/operator/operator-config.local.ps1`, fill in your own values, and
run `. ./deploy/operator/operator-config.local.ps1` in the operator shell.
The local file is ignored; never put passwords, tokens, or private key contents
in the example. Explicit script parameters override environment defaults.
For the Bun harness, export the same environment variables in its shell. Set DEVIN_OPERATOR_REMOTE_DIR to the absolute remote checkout path.

Deployment state, test results, backups, and untracked operator files are ignored.
Ignoring does not untrack files or erase existing commits. Before publication,
stage specific files, run `pwsh -NoProfile -File scripts/Test-PublicationSafety.ps1`,
review `git diff --cached`, and review every outgoing commit and its files.
The check scans staged files and outgoing patches against locally known origin refs for known patterns, not
all possible secrets. Fetch first and verify the actual destination; refs can be stale. A passing check is not proof that a push is safe.
