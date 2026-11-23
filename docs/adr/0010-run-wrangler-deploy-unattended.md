# ADR-0010: Run Wrangler deploy unattended

Date: 2026-11-23
Status: Accepted

## Context

On a first deploy, interactive Wrangler can offer to name or reuse a D1 database and write provisioned resource IDs into the committed configuration. The migration step expects a database under the default name. Wrangler can also exit successfully when the operator declines to apply migrations.

## Decision

Run Wrangler's deploy step with stdin closed to keep resource provisioning predictable. After applying migrations, ask D1 whether any remain. Stop if they do, even when the apply command succeeded. Check the deployed hostname before reporting success.

Keep server settings out of child process environments. Give the Vite build empty values so it can run without warnings or writing real settings to its output. Pass new settings to Wrangler through a temporary file readable only by the current user. Use JSON because Wrangler expands dollar-prefixed references in dotenv files. Handle ordinary interrupt signals in the wrapper long enough to remove the file after Wrangler exits.

## Consequences

An update stops before replacing the running Worker if migrations remain pending. On a first deploy, Wrangler provisions resources first and the Worker stays unavailable until migrations complete. After deployment, the wrapper checks that the public endpoints respond as expected, including whether Cloudflare Access blocks them.
