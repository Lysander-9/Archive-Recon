# Proxy/network recovery handoff

The candidate contains fixes since released `5a548b3`, approved R9/r2 terminal expectations, and the preserved interrupted work from `daba903`. It does not change proxy protocols, TLS checks, query/response budgets or release assets.

## Changes

- Public errors, DTOs, reason events/views and copied summaries remove credential values. Unknown transport messages and HTTP bodies are not published. Context is limited to stage/kind, Chromium code, HTTP status, attempts, timeout/budget counters and bounded malformed-line numbers; unknown nested causes are excluded.
- Task-session resolution and advice share a 500ms diagnostic boundary and respond to cancellation. Abort listeners are cleaned and late resolution cannot invoke advice after the boundary closes. Diagnostics cannot prevent task finalization.
- Fixed-proxy challenges must match the configured endpoint. Missing credentials produce authentication-required; matching challenges receive at most two credential answers. Other endpoints receive no credentials and do not become guessed password errors. Auth failures are not transiently retried or switched to direct.
- One request deadline covers I/O and backoff. Each attempt checks cancellation/deadline first; timeout retains the attempted count.
- Successfully completed CC indexes include pages=0. Empty success plus failure is partial; all indexes failing without records is failed. Existing records and first-URL deduplication remain intact.

`direct` is explicit direct access, `system` is OS policy, environment variables are suggestions. Task-session resolveProxy is diagnostic only; empty/unavailable resolution does not prove direct access or proxy health.

## Normal verification

```text
npm run typecheck
npm test
npm run build
npm run test:e2e
node acceptance/run-acceptance.mjs
node acceptance/prepare.mjs
node_modules/electron/dist/electron.exe acceptance/proxy/generated/run-https-proxy-acceptance.cjs
```

The HTTPS runner uses local TLS/CDX/CONNECT fixtures unless its separate optional `ARCHRECON_OFFICIAL_HEALTH` flag is enabled. Leave that flag disabled for recovery checks. Test certificate trust and loopback overrides do not change production TLS/proxy settings.

Additional Node regressions can be bundled with the locked esbuild:

```text
node_modules/.bin/esbuild tests/regression/proxy-recovery.test.ts --bundle --platform=node --format=cjs --outfile=acceptance/harness/generated/proxy-recovery.cjs
node acceptance/harness/generated/proxy-recovery.cjs
node_modules/.bin/esbuild tests/regression/proxy-auth.test.ts --bundle --platform=node --format=cjs --alias:electron=./tests/regression/electron-boundary.ts --outfile=acceptance/harness/generated/proxy-auth.cjs
node acceptance/harness/generated/proxy-auth.cjs
```

The auth suite mocks only the Electron request event boundary for deterministic challenge ordering/cleanup. It supplements the real HTTPS runner.

## Scope of takeover validation

This Windows sandbox denies anonymous child-process pipes. The 116 unchanged acceptance tests ran in-process with Node test isolation disabled; actual child commands used file handles for stdout/stderr, preserving commands, environments, exit status and output, including timezone subprocesses. Standard Playwright workers fail with `spawn EPERM`; 88 unchanged unit bodies and original Playwright matchers additionally ran with a Node in-process scheduler. That is not a standard Playwright or window-E2E pass claim.

Real Electron startup is blocked by `install_dir_access.cc:52`: the runtime ACL has an AppContainer SID but lacks ALL APPLICATION PACKAGES read access. A narrow grant on the copied runtime was denied; using the original binary also failed the same check. No sandbox-disabling flag or TLS workaround was used. The real controlled HTTPS suite and window E2E therefore require independent rerun against this candidate SHA; prior daba903 results do not validate this candidate.

This is a development handoff for independent DevOps testing and review. No publication, package/signing, clean-Windows verification or public-release approval is claimed.
