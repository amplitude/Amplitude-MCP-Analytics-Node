# Vendored from @amplitude/ai

A small set of utility files in this package originated in
[`amplitude/Amplitude-AI-Node`](https://github.com/amplitude/Amplitude-AI-Node).
Each vendored file carries a header naming its source path and the commit it
was copied from.

## Why vendor instead of depend

`@amplitude/ai` models the agent / turn / message domain. This SDK models the
MCP server / session / tool-invocation domain. The two have different
audiences, release cadences, and event taxonomies. They share only a small
core of low-level utilities (module resolution, and — in future PRs —
privacy redaction, serverless flush accounting, delivery contract) that is
too small to justify a separate shared package and too risky to reinvent.

A hard dependency on `@amplitude/ai` would couple our release cadence to
theirs and inherit their domain model on every upgrade. Vendoring avoids
both.

## This is a fork point, not a sync target

Provenance headers exist for attribution and archaeology: a future maintainer
can reconstruct exactly which version of upstream a file was copied from and
reason about how it has since diverged. There is **no commitment** to track
upstream — once a file is vendored it belongs to this repo and evolves with
MCP needs.

If a specific upstream change is worth pulling in, do it as a normal PR:
apply the diff (adjusting for any MCP-specific adaptations the header
records), bump the SHA in the header and the inventory below, and commit
with a subject like `chore: refresh vendored utils/resolve-module from
amplitude-ai @ <sha>`. There is no scheduled re-sync.

## Inventory

| File | Source | Vendored at | Notes |
| --- | --- | --- | --- |
| `src/utils/resolve-module.ts` | `src/utils/resolve-module.ts` | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | Verbatim. |
| `src/core/delivery/serverless.ts` | `src/serverless.ts` + `src/client.ts` | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | `isServerless`/`_resetServerlessCache` verbatim; `_globalUnflushedCount`/`_registerExitHook` lifted out of the `AmplitudeAI` class into free functions. Warning text re-prefixed and de-LLM-ified. |
| `src/core/delivery/proxy.ts` | `src/client.ts` (`TrackingProxy`) | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | Added `trackCountSinceFlush`; flush/shutdown settle it against the module-level counter (bookkeeping lived on `AmplitudeAI` upstream). |
| `src/core/delivery/hooks.ts` | `src/client.ts` (`_installTrackHook`, `_installTrackCounter`, `_warnShortId`) + `src/utils/logger.ts` + `src/utils/debug.ts` | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | Methods extracted to free functions taking `(client, config)`. Dropped `onEventCallback` path. Debug line reimplemented taxonomy-free. Logger inlined. Prefixes re-labelled. |
