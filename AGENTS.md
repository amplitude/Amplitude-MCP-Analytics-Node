# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. Read this
before making changes. It captures the tenets and conventions the team aligns
on so that parallel sessions produce consistent, shippable work.

This file is **internal** to the development team. It is not customer-facing —
that is what `README.md` is for.

## What this project is

`@amplitude/mcp-analytics` is a **public, customer-facing SDK** for tracking
Model Context Protocol (MCP) server usage in Amplitude. It mirrors the developer
experience of `@amplitude/ai` (build tooling, repo layout, constructor shape,
mock test client) but the **domain model is MCP-native** — servers, sessions,
tool invocations — and intentionally does not reuse agent vocabulary.

## Tenets

These are the principles we use to break ties when a specific rule doesn't cover
a situation.

1. **The public API is a promise.** Anything exported becomes a semver contract.
   Keep the public surface minimal; prefer adding API later over removing it.
2. **Optimize for the consumer's ease of use.** The common case must work with
   minimal config and sensible zero-config defaults. Wrap, don't rewrite: an
   integration should not force consumers to change their existing handler
   signatures, implement our interfaces, or hand-build values the SDK can
   derive itself. Advanced hooks (custom resolvers, overrides) are opt-in
   escape hatches for the long tail — never the required path for the basics.
3. **Customer-facing artifacts assume zero internal knowledge.** `README.md`,
   error messages, and published types must make sense to someone outside
   Amplitude. No internal ticket numbers, no Slack/Linear links, no team jargon.
4. **Nothing internal or sensitive gets committed — ever.** The repo and its
   full git history are public. No secrets, API keys, tokens, internal URLs, or
   customer data. A secret committed once lives in history forever.
5. **Backwards compatibility is the default.** Don't break consumers or force
   dependency conflicts. Keep peer-dependency ranges wide; don't re-export a
   dependency's types into our public API unless we intend to track them.
6. **Vendoring is a fork point, not a sync target.** Vendored code belongs to
   this repo once copied; there is no obligation to track upstream.
7. **Degrade honestly.** When we can't derive something accurately (e.g. a user
   or session on stateless transport), emit accurate aggregate-only data rather
   than fabricating it.
8. **Small, atomic PRs over large ones.** One concern per PR; scoped so a
   reviewer can hold it in their head.
9. **When scope is ambiguous, stop and ask** rather than guessing.

## Public API surface

The published surface is **curated, not automatic.**

- Public entry points are the explicit list in `tsdown.config.ts` (`entry`).
  Each becomes a `package.json` subpath export. Add a file there only when you
  intend to support importing it forever.
- Internal modules (`src/core/**`, `src/utils/**`) are compiled and emitted
  because public entries import them, but are **not** package exports. Do not
  add them to `entry`.
- Mark internal/test-only symbols with `@internal`; `stripInternal` removes them
  from the published `.d.ts`. Test-only helpers should also be prefixed `_`.
- Before changing exports, ask: "Am I willing to support this import for the life
  of the package?" If not, keep it internal.

## Customer-facing vs internal references

- **No ticket numbers** in `README.md`, shipped source comments, or error messages. 
  Internal references shouldn't be in anything that ships or that a customer reads.
- Keep maintainer/process docs (vendoring policy, architecture rationale) out of
  the customer README; put them here or in `VENDORED.md`.
- **Keep `README.md` in sync with the API.** When you introduce or change public
  functionality (a new export, a changed signature, a new config option, a new
  install/usage step), update `README.md` in the **same PR**. Customer-facing
  docs must never lag the public surface.

## Vendoring policy

Some low-level utilities are vendored from `@amplitude/ai` rather than depended
on. See `VENDORED.md` for the full policy and inventory. Rules:

- Every vendored file carries a header naming the **source path** and the
  **upstream commit SHA** it was copied from.
- Update both the header and the `VENDORED.md` inventory row when you add or
  refresh a vendored file.
- Adapt freely for MCP needs; record adaptations in the header.

## Conventions

- **Package manager:** `pnpm` (version pinned in `package.json` `packageManager`).
- **PRs:** link the ticket, reference related PRs, and explicitly call out what is
  intentionally out of scope or stubbed.
- **Peer dependencies (`@modelcontextprotocol/sdk`, `@amplitude/analytics-node`):**
  keep the peer range wide so consumers use whatever version their server already
  has. The MCP SDK floor is **1.14.0** — the earliest release exposing both
  `RequestHandlerExtra._meta` and `.requestInfo` (the fields we read; `requestInfo`
  is the later addition and sets the floor). The **dev-dependency is pinned to the
  exact floor** (not `^`, not latest) so the compiler fails if we ever use a newer
  SDK API a floor consumer wouldn't have — the dev-dep is our floor guard, since it
  does not otherwise enforce the peer range. Raising the floor is a deliberate,
  documented change (it shrinks the set of servers that can adopt the SDK).

## mcp-server migration (stateless transport)

> For the team migrating Amplitude's own MCP server. The transport seam is
> "legacy-complete, stateless-ready" — the legacy path is live; the stateless
> (`2026-07-28+`) path is coded and fixture-tested but disabled until the SDK
> speaks it. Shed these assumptions before enabling it:

- **No `Mcp-Session-Id`** — don't read or require it. Use the SDK-derived anchor
  (a `session-id` only when present, else a trace, else an anonymous floor) and
  treat it as opaque.
- **No `initialize` handshake** — `clientInfo` / `protocolVersion` ride `_meta`
  per request on the stateless path; the legacy handshake capture is
  per-connection.
- **No sticky routing / session store** — any request may hit any instance;
  correlation comes from `traceparent` in `_meta`, not server-held state.
- **No `session ended`** — flush on shutdown (stdio) and a best-effort timer (HTTP).
- **Product consequence** — stateless per-user/session analysis needs a
  customer-supplied `userId` or propagated trace context; absent both, metrics
  are aggregate-only (no fabricated users).

## Verify before you finish

All of these must pass:

```bash
pnpm install
pnpm build
pnpm test:typescript
pnpm test
pnpm lint
```

Add tests next to the behavior you change. The smoke test in `test/` is the
tripwire for forgotten public exports — keep it green.
