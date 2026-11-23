# ADR-0014: Run Worker tests in workerd

Date: 2026-11-23
Status: Accepted

## Context

Some Worker integration tests check how the Worker's rendered HTML behaves in a browser. Playwright launches Chromium from Node for those checks.

## Decision

Run Worker integration tests in workerd. Send rendered HTML to a test-only Miniflare service in Node when a test needs Chromium.

## Consequences

- Disable Vitest's filesystem module cache. With it enabled, the Cloudflare plugin can send all warm modules in one WebSocket message when a pool slot gets its next test file. On machines with few cores, that message can exceed workerd's limit and close the connection with code 1009.
- Pass original prepared statements to native D1 batches when tests wrap statements to observe them. Native D1 does not accept the proxies.
- Open D1 and both KV bindings before resetting storage. Workerd resets storage through live instances, so an idle-evicted instance can leave its data, including the migration table, behind. [Workerd storage reset](https://github.com/cloudflare/workerd/blob/v1.20261023.1/src/workerd/server/server/actor.rs#L230)
- Model KV expiry by deleting the key while retaining the browser cookie. Local KV uses real time even when the test changes the Worker's clock.
- Assert `redirect: "manual"` on outgoing OAuth POST requests. MSW can reject a redirect for a POST body before following it, so observing that it was never followed is insufficient.
- Cap the CI job at 15 minutes, well above its expected duration. A stuck workerd runner can prevent Vitest from reporting its timeouts. GitHub's default cap would let the job run for six hours.
