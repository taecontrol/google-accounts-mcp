# ADR-0013: Keep fixed names for browser assets

Date: 2026-11-23
Status: Accepted

## Context

The Worker renders HTML that links to the browser bundle and stylesheet. Hashed filenames would require the Worker to read a build manifest. Workers Static Assets already supplies cache revalidation with ETags. [Workers Static Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)

## Decision

Build the script and stylesheet under fixed names so the Worker can link directly to them. Use Cloudflare's default revalidation headers to keep cached assets fresh.

## Consequences

Browsers can reuse unchanged assets after revalidation. The same URL can return different bytes after a deploy, so the URL cannot identify the version used to render a page.
