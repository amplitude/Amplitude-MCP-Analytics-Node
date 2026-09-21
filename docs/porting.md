# Porting MCP analytics to another language

Amplitude publishes first-party MCP analytics SDKs for
[Node/TypeScript](https://github.com/amplitude/Amplitude-MCP-Analytics-Node) and
[Python](https://github.com/amplitude/Amplitude-MCP-Analytics-Python). If your
MCP server is written in Go, Java, C#, Ruby, Rust, PHP, or anything else, you
can get the same data into Amplitude by implementing the event contract
yourself. This guide is how.

Nothing here requires a private API or an Amplitude-side change. The SDKs are
convenience wrappers: they observe an MCP server, build events, and hand them to
the ordinary [Amplitude HTTP V2 ingestion
API](https://amplitude.com/docs/apis/analytics/http-v2). A port that produces
the same events is indistinguishable from a first-party SDK downstream — same
charts, same segmentation, same taxonomy.

**The event contract, not the source code, is the thing to copy.**
[`events.md`](./events.md) is the normative specification: every event, every
property, the exact conditions each fires under. Read it alongside this guide.
Treat the TypeScript source as a reference implementation you may consult, not
as a thing to transliterate — much of it is working around Node and MCP
TypeScript SDK specifics that will not exist in your language.

## Support boundary

Be clear-eyed about what you are taking on:

- **Amplitude supports the ingestion API and the event contract.** If HTTP V2
  rejects your payload, or [`events.md`](./events.md) is ambiguous or wrong,
  that is ours to fix.
- **You own your implementation.** Amplitude does not review, certify, test, or
  support third-party ports, and a port is not on the first-party release
  cadence.
- **The contract is versioned, and it moves.** New events and properties are
  added; occasionally something breaking lands (see
  [Staying in sync](#staying-in-sync)). Pin the version of the spec you built
  against and re-read the changelog before upgrading.

If you would rather not own this, tell your Amplitude contact which language you
need. Demand is how the first-party SDK list grows.

## The two layers

A port is two separable pieces of work. Most of the difficulty is in the second.

| Layer | What it does | How hard |
| -- | -- | -- |
| **Delivery** | Batch events, POST them to Amplitude, retry, flush on shutdown | Easy — an existing Amplitude SDK, or ~200 lines against HTTP V2 |
| **Instrumentation** | Observe the MCP server, derive identity and context, decide what fires | The real work — depends entirely on what your MCP SDK lets you hook |

Build them in that order. Get a hand-written event into Amplitude first,
confirm it lands, and only then wire up the MCP observation. Debugging
"nothing is arriving" is much easier when only one layer is new.

## Layer 1 — delivery

### Use a first-party Amplitude SDK if one exists

Amplitude ships analytics server SDKs for several languages
([catalog](https://amplitude.com/docs/sdks)) — Node, Python, and Java among
them. If yours is on the list, use it. It already handles batching, retry with
backoff, `insert_id` deduplication, server-zone routing, and flush-on-shutdown.
Your port then only has to build the event dictionaries and call `track()`,
which is exactly what the Node SDK does.

### Otherwise, post to HTTP V2 directly

```
POST https://api2.amplitude.com/2/httpapi      (US)
POST https://api.eu.amplitude.com/2/httpapi    (EU)
Content-Type: application/json
```

~~~json
{
  "api_key": "<project api key>",
  "events": [
    {
      "event_type": "[MCP] Tool Call Response",
      "user_id": "user-123",
      "device_id": "1c6afb4c-6ba7-5f5d-9c2e-6a1f8d1f2ab3",
      "time": 1758412800000,
      "insert_id": "b3f1c2d4-...",
      "groups": { "org id": "456" },
      "event_properties": { "[MCP] Tool Name": "search_docs" }
    }
  ]
}
~~~

What you must get right at this layer:

- **`user_id` or `device_id` is required**, and Amplitude silently drops ids
  shorter than 5 characters. The identity chain below always yields at least one
  valid id, which is the whole reason it exists.
- **`time`** in milliseconds since epoch. Set it at the moment the event
  occurred, not at flush time, or your latency and funnel analysis will be
  skewed by your own batching.
- **`insert_id`** — a UUID per event. This is what makes retries safe:
  Amplitude deduplicates the same `insert_id` on the same `device_id` within 7
  days. Do not skip it.
- **Retry `429` and `5xx` with exponential backoff.** Treat `400` as a bug in
  your payload and log it loudly rather than retrying — it will never succeed.
  `413` means split the batch.
- **Respect the limits.** Under 1 MB and under 2000 events per request; there
  is also per-device throttling around 30 events/second. An MCP server is
  unlikely to approach these, but a hot `tools/list` loop can.
- **Route to the right server zone.** An EU project will silently receive
  nothing if you post to the US endpoint.
- **Set `library`** to something identifying, e.g.
  `amplitude-mcp-analytics-go/0.1.0`. It costs nothing and makes your own
  events debuggable later.

### Flush discipline

This is the single most common way a port silently loses data.

Events are buffered. If your process exits — or a serverless runtime freezes —
before the buffer is flushed, those events are gone. The Node SDK counts
unflushed events and warns at exit for exactly this reason.

- **Long-lived servers (stdio, persistent HTTP):** flush on an interval and on
  shutdown signals.
- **Serverless / per-request hosts:** flush before the handler returns. Do not
  rely on a background timer; the runtime may freeze between invocations and
  never fire it. Detect the environment the way the reference implementation
  does (`AWS_LAMBDA_FUNCTION_NAME`, `FUNCTION_TARGET`, `WEBSITE_INSTANCE_ID`,
  and friends) and warn when events were tracked but never flushed.

## Layer 2 — MCP instrumentation

### The hook points

Everything the SDK emits comes from four observation points. Before you start,
check that your MCP SDK exposes them — this is the feasibility question that
actually matters, and the answer varies a lot between SDKs.

| Hook | What you observe | Events it drives |
| -- | -- | -- |
| `initialize` request handler | Client name/version, handshake time | `[MCP] Session Initialized` |
| Transport close | Connection teardown | `[MCP] Session Ended` |
| `tools/list` request handler | Tool count and names, duration, errors | `[MCP] Tools Listed` |
| Tool handler wrapper | Args, result, duration, errors | `[MCP] Tool Call Response` |
| `tools/call` dispatch failure | Rejections before any handler runs | `[MCP] Tool Call Rejected` |

Most SDKs give you handler registration and some form of middleware, which
covers the first four. The fifth needs access to the server's tool registry and
is the one most likely to be impractical — see
[Tiers](#conformance-tiers).

### Rules that apply to every hook

**Never change the behavior of what you wrap.** Instrumentation that can break
a tool call is worse than no instrumentation. Concretely:

- Swallow every error raised inside your own tracking code, log it, and carry
  on. The tool's result must pass through untouched.
- On a handler that throws, emit the failure event **before** re-raising, then
  re-raise the original error unmodified.
- Never modify the text or structure returned to the client. Redaction hooks
  affect telemetry only.
- If the server was never instrumented, the tool wrapper must be a transparent
  pass-through.

**Substitute Node's `AsyncLocalStorage` with your language's equivalent.** The
reference SDK uses it so a handler can call `setIdentity()` or `setRationale()`
at any call depth without threading a context object through. Use
`contextvars` (Python), `context.Context` (Go — explicit passing, which is
idiomatic there anyway), `ScopedValue` or `ThreadLocal` (Java), `AsyncLocal`
(C#), or just require an explicit context parameter. An explicit parameter is a
perfectly good design; it is a DX choice, not a correctness one.

## What conformance means

These are the things that must be exact, because they are what downstream
charts key on. Everything else is implementation detail.

### 1. Names are byte-exact

Every SDK-emitted event name and property name is prefixed `[MCP] ` — **with a
trailing space**. `[MCP]Tool Name` and `[MCP] tool name` are different
properties from `[MCP] Tool Name`, and Amplitude will happily create all three.
A typo here is not a crash; it is a silently split dimension that someone
discovers three months later.

Copy the names from the [property index](./events.md#property-index) as string
literals. Define them as constants in one file. Add a test that asserts the
literal values.

### 2. The identity chain

Resolve identity per request, first match wins:

| Order | Source | `user_id` | `device_id` |
| -- | -- | -- | -- |
| 1 | Explicit call inside the handler | as supplied | as supplied, else derived from anchor |
| 2 | Resolver over auth claims | as supplied | as supplied, else derived from anchor |
| 3 | Static server-level identity | as supplied | as supplied, else derived from anchor |
| 4 | Correlation anchor | `<anchorType>:<anchorValue>` | `uuidv5(anchorKey)` |
| 5 | Anonymous floor | `anonymous:<deviceId>` | random UUIDv4 per request |

The **anchor** is the correlation key derived from the transport:

| Transport | Anchor type | Anchor value | `[MCP] Session ID` |
| -- | -- | -- | -- |
| stdio | `process` | `<pid>-<random hex>`, minted once per process | `no-session` |
| Streamable HTTP, session id present | `session-id` | the transport session id | the session id |
| Streamable HTTP, stateless, `traceparent` present | `trace` | the 32-hex trace id | `no-session` |
| Streamable HTTP, stateless, no trace | `anonymous` | random UUID per request | `no-session` |

Two details that are easy to get wrong and expensive to discover later:

- **Do not use a bare pid as the stdio anchor value.** Pids are small integers
  recycled per machine, so two unrelated servers on different hosts collide and
  merge into one Amplitude user. Append a per-process random token.
- **Never fabricate a session id.** Its absence is what selects the stateless
  branch. Emit the literal `no-session`.

### 3. `device_id` derivation

At anchor level, `device_id` is a **UUIDv5 (RFC 9562 §5.5)** of the anchor key
under this namespace:

```
namespace = f08626eb-3a5c-4f3a-bec2-227ab3178022
name      = "<anchorType>:<anchorValue>"
device_id = uuidv5(namespace, name)
```

**Why hash at all?** Amplitude requires a `user_id` or `device_id` on every
event, and an MCP server frequently has neither — no login, and on stateless
HTTP nothing that survives the request. Minting a random id per request would
turn every tool call into a new "device" and make unique-device counts
meaningless. Hashing a stable anchor instead gives the same id for the same
session or process every time, **without storing anything** — no lookup table,
no cache to warm, nothing to lose across a serverless cold start.

**What the namespace does.** It is an input to the hash, not a field on the
event; it never appears in the ingestion payload. What it controls is the
*mapping* from anchor to `device_id`. Two implementations that agree on
everything else but use different namespaces will produce two disjoint device
populations for identical traffic, and nothing on the wire will say why — which
is precisely why the test vectors below are worth running before you trust your
output.

This is standard, unmodified UUIDv5 — SHA-1 over the namespace's 16 raw bytes
followed by the UTF-8 name, with version and variant bits set. Use your
language's UUID library; do not hand-roll it. (The Node SDK hand-rolls it only
because the package carries no runtime dependencies.)

Verify your library against the published RFC vectors first:

| Namespace | Name | Expected |
| -- | -- | -- |
| `6ba7b810-9dad-11d1-80b4-00c04fd430c8` (DNS) | `www.example.com` | `2ed6657d-e927-568b-95e1-2665a8aea6a2` |
| `6ba7b810-9dad-11d1-80b4-00c04fd430c8` (DNS) | `python.org` | `886313e1-3b8a-5372-9b90-0c9aee199e5d` |

Then check your implementation against these, which use the MCP analytics
namespace above:

| Anchor key | Expected `device_id` |
| -- | -- |
| `session-id:3fa85f64-5717-4562-b3fc-2c963f66afa6` | `18ac030b-d5ba-5b6a-a79f-ad6b992b1ef4` |
| `process:12345-1f0cbd3a6b4e4f0a9c2d7e8f1a2b3c4d` | `ed7a1818-ddbf-5bcc-ba25-db42abe39900` |
| `trace:4bf92f3577b34da6a3ce929d0e0e4736` | `816b1211-5802-5d6a-b69a-0edec8a18103` |

Matching the namespace matters only if you later migrate to a first-party SDK,
or run a port and an official SDK side by side: it keeps the same anchor
resolving to the same device across the cutover instead of resetting your whole
device population. If neither applies, any stable namespace of your own works.

Whichever you pick, **do not use one of the four namespaces RFC 9562 reserves**
(DNS, URL, OID, X.500). Their purpose is domain separation: a namespace you own
guarantees your derivation cannot collide with any other system that happens to
hash similar-looking names. A reserved constant gives up that guarantee for
nothing. Pick a random v4 UUID once and treat it as fixed — changing it later
re-derives every `device_id` you have ever sent, which is a breaking change for
your data.

### 4. The skip rule

An event that resolves to the **anonymous floor and carries no tenant** is
**dropped**, not sent. Each such request mints a fresh `device_id` that never
recurs, so emitting them inflates unique-user and unique-device counts with
noise.

In practice this only affects stateless Streamable HTTP with no identity
configured and no trace context propagated. Provide an opt-in flag to emit them
anyway as aggregate-only data, defaulted off.

### 5. Measurement conventions

- **Durations** are wall-clock milliseconds, rounded to the nearest integer.
  Use a monotonic clock, not wall time, to measure them.
- **Sizes** are the UTF-8 byte length of the value's **JSON serialization** —
  payload semantics, not bytes on the wire. Omit the property when the value is
  not JSON-serializable rather than sending `0`. As a check:
  `{"q":"héllo"}` serializes to 14 bytes.
- **Tenant** goes on Amplitude `groups` as `{groupType: groupValue}`, never as
  an event property.

### 6. Closed vocabularies

Emit these values verbatim. They are closed sets that the SDK assigns; do not
invent new members, and describe host-specific failures through the free-form
`[MCP] Error Code` instead.

| Property | Allowed values |
| -- | -- |
| `[MCP] Transport` | `stdio`, `streamable-http` |
| `[MCP] Anchor Type` | `process`, `session-id`, `trace`, `anonymous` |
| `[MCP] Error Type` | `returned_error`, `thrown_exception`, `timeout`, `transport_error`, `protocol_error`, `rate_limited`, `unknown` |
| `[MCP] Rejection Reason` | `unknown_tool`, `disabled_tool`, `schema_validation`, `unrecognized` |

Sentinel values are the literals `no-session` (for `[MCP] Session ID`) and
`unknown` (for `[MCP] Client Name` and `[MCP] User Agent`).

Error classification maps to your language's error model, not Node's:
`timeout` is your cancellation error, `transport_error` is your network error
class (the Node SDK matches `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`,
`ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`), and `rate_limited` is any failure carrying
HTTP 429.

### 7. Caps and property precedence

| Value | Cap |
| -- | -- |
| `[MCP] Tool Names` | 100 entries, then set `[MCP] Tool Names Truncated` (`[MCP] Tool Count` still reports the true total) |
| `[MCP] Attempted Tool Name` | 200 characters |
| `[MCP] Rationale` | 1000 characters |

Properties merge in a fixed order, later sources overwriting earlier:

```
reserved (SDK-derived)  <  extra (context bag)  <  properties (per call)
```

On the default events, the SDK's own outcome values ride as per-call
`properties`, so a colliding `extra` key cannot overwrite them.

## Conformance tiers

You do not have to build all of it. Ship in this order — each tier is useful on
its own.

**Tier 1 — the core.** `[MCP] Tool Call Response` plus the
[shared properties](./events.md#shared-properties) and the identity chain. This
is most of the value: adoption, tool popularity, latency, error rate, per-client
segmentation. If you build only this, you have a working integration.

**Tier 2 — lifecycle.** `[MCP] Session Initialized`, `[MCP] Session Ended`,
`[MCP] Tools Listed`. Adds session counts, durations, and discovery behavior.
Cheap once Tier 1 works.

**Tier 3 — the long tail.** `[MCP] Tool Call Rejected`, rationale capture, error
message sanitization, custom events.

A word on `[MCP] Tool Call Rejected`: it is the hardest to port and the most
fragile. It requires reading the server's tool registry to distinguish
`unknown_tool` from `disabled_tool`, and `schema_validation` is matched from the
MCP SDK's error *prose*, which has been reworded across versions. If your MCP
SDK does not expose its registry, skip this event rather than guessing — a wrong
`[MCP] Rejection Reason` is worse than an absent one. Emitting it with only
`unrecognized` is a legitimate partial implementation.

Do **not** emit a default event you cannot populate honestly. An absent event is
a known gap; a fabricated one is a wrong answer that nobody catches.

## Golden fixture

Diff your output against this. It is a successful tool call over legacy
Streamable HTTP with an OAuth-resolved identity, and it is the shape every
Tier 1 implementation should produce.

~~~json
{
  "event_type": "[MCP] Tool Call Response",
  "user_id": "user-123",
  "device_id": "1c6afb4c-6ba7-5f5d-9c2e-6a1f8d1f2ab3",
  "time": 1758412800000,
  "insert_id": "9f2b7c1e-4d3a-4b8f-9e1c-7a5d2f8b0c34",
  "groups": { "org id": "456" },
  "event_properties": {
    "[MCP] Session ID": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "[MCP] Client Name": "cursor",
    "[MCP] Client Version": "0.40",
    "[MCP] OAuth Client ID": "c7f1a0d2-9b3e-4a11-8f6c-2d5e7b9a0c13",
    "[MCP] User Agent": "node",
    "[MCP] Server Name": "my-mcp-server",
    "[MCP] Server Version": "1.0.0",
    "[MCP] Transport": "streamable-http",
    "[MCP] Anchor Type": "session-id",
    "[MCP] Protocol Version": "2025-11-25",
    "[MCP] Auth Type": "oauth",
    "[MCP] Tool Name": "search_docs",
    "[MCP] Tool Owner": "docs-team",
    "[MCP] Is Error": false,
    "[MCP] Response Duration": 184,
    "[MCP] Request Size": 64,
    "[MCP] Response Size": 2048,
    "feature flag": "new-ranker"
  }
}
~~~

## Validating your port

Work down this list before you trust the data.

1. **UUIDv5 vectors pass** — both the RFC pair and the anchor-key table above.
2. **Property names are asserted as literals** in a test, including the
   trailing space in `[MCP] `.
3. **A real event lands.** Send one to a scratch Amplitude project and confirm
   it appears, with `user_id`/`device_id` populated and properties typed
   correctly (numbers as numbers, booleans as booleans, `[MCP] Tool Names` as an
   array of strings). A number arriving as a string is the classic dynamically
   typed port bug.
4. **Failure paths emit and re-raise.** Assert that a throwing handler produces
   the event *and* propagates the original error unmodified.
5. **Tracking errors are contained.** Force your delivery layer to throw and
   assert the tool call still succeeds.
6. **The skip rule holds.** A stateless request with no identity and no tenant
   emits nothing by default.
7. **Anchors are stable within a scope and distinct across them.** Two calls in
   one session share a `device_id`; two separate processes do not.
8. **Flush actually happens** on shutdown, and before return under serverless.
9. **Side-by-side, if you can.** Run your port and the Node SDK against
   equivalent servers and diff the resulting event payloads. This catches more
   than any unit test.

## Common pitfalls

- **Dropping the trailing space** in the `[MCP] ` prefix. Silent taxonomy split.
- **Measuring duration with wall-clock time.** Use a monotonic clock; NTP
  adjustments produce negative durations.
- **Sending sizes as bytes-on-the-wire.** The spec is the JSON serialization's
  byte length.
- **Emitting the anonymous floor.** Inflates unique counts with ids that never
  recur. Honor the skip rule.
- **Using a bare pid as the stdio anchor.** Merges unrelated installs.
- **Forgetting `insert_id`.** Makes every retry a duplicate event.
- **Letting tracking failures escape** into the tool's control flow.
- **Never flushing under serverless.** Everything works locally and nothing
  arrives in production.
- **Putting the tenant in `event_properties`** instead of `groups`.
- **Setting `time` at flush** rather than at the moment of the event.
- **Sending an EU project's events to the US endpoint.** Silent data loss.
- **Emitting free-text error messages unfiltered.** `[MCP] Error Message` is the
  one error property carrying text the SDK did not compose; validation failures
  routinely quote the offending argument value. Provide a sanitizer hook, have
  it fail closed (a sanitizer that throws drops the property rather than falling
  back to the raw message), and never alter what the client receives.

## Staying in sync

- [`events.md`](./events.md) is the normative spec. Watch this repository for
  releases.
- The contract follows semver at the package level. Additive changes (new
  events, new properties) are minor; breaking changes are called out in the
  release notes. `device_id` derivation has changed once, in a major release —
  such changes will always be flagged explicitly.
- Read the Node or Python implementation when the spec is ambiguous. If you had
  to read the source to answer a question, the spec has a gap:
  [open an issue](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/issues).
  That feedback is genuinely useful and improves the spec for everyone.
- Tell Amplitude you built one. It is the clearest possible signal for
  prioritizing a first-party SDK in your language.
