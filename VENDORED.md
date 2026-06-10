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
| `src/core/delivery/proxy.ts` | `src/client.ts` (`TrackingProxy`) | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | Extracted into its own module; otherwise verbatim. The unflushed-count bookkeeping stays on the host client (`flush`/`shutdown`), as in AI-Node, so the proxy is a pure wrapper. |
| `src/core/delivery/hooks.ts` | `src/client.ts` (`_installTrackHook`, `_installTrackCounter`, `_warnShortId`) | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | Methods extracted to free functions taking `(client, config)`. `installTrackCounter` takes an `onTracked` callback so the host client keeps its own count-since-flush (a class field in AI-Node). Dropped `onEventCallback` path. Prefixes re-labelled. |
| `src/utils/logger.ts` | `src/utils/logger.ts` | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | Near-verbatim; default console prefix re-labelled. |
| `src/utils/debug.ts` | `src/utils/debug.ts` | `97ea346abd0caf333a3bafbd26b74de1d545f3e7` | `formatDryRunLine` verbatim; `formatDebugLine` is a placeholder (emits event type only) until the MCP event taxonomy lands — AI-Node's keys off event/property constants, which are out of scope. |
