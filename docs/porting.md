# Porting MCP analytics to another language

Amplitude publishes first-party MCP analytics SDKs for
[Node/TypeScript](https://github.com/amplitude/Amplitude-MCP-Analytics-Node) and
[Python](https://github.com/amplitude/Amplitude-MCP-Analytics-Python). Your MCP
server can be in Go, Java, C#, Ruby, Rust, PHP, or another language. To send the
same data to Amplitude, implement the event contract yourself.

This work needs no private API. It also needs no change on the Amplitude side.
The SDKs are convenience wrappers. They watch an MCP server, build events, and
send them to the standard
[Amplitude ingestion API (HTTP V2)](https://amplitude.com/docs/apis/analytics/http-v2).
Downstream, Amplitude treats a port's events the same as a first-party SDK's
events.

**Copy the event contract, not the source code.**
[`events.md`](./events.md) is the normative specification. It lists every event
and every property. It also gives the exact conditions for each one. Read it
next to this guide. You can read the TypeScript source as a reference
implementation, but do not transliterate it. That source works around details
of Node and of the MCP TypeScript SDK.

## Support boundary

This is the division of responsibility:

- **Amplitude supports the ingestion API and the event contract.** HTTP V2 can
  reject your payload. [`events.md`](./events.md) can be unclear or wrong.
  Amplitude fixes both.
- **You own your implementation.** Amplitude does not review, certify, test, or
  support a third-party port. A port does not follow the first-party release
  cadence.
- **The contract has versions, and it changes.** Amplitude adds new events and
  new properties. Breaking changes occur. See
  [Staying in sync](#staying-in-sync). Pin the version of the specification you
  build against. Read the changelog before you upgrade.

To request a first-party SDK instead, tell your Amplitude contact which
language you need. Amplitude prioritizes new SDKs by demand.

## The two layers

A port has two separate pieces of work. The second piece takes more work than
the first.

| Layer | What it does | Effort |
| -- | -- | -- |
| **Delivery** | Batches events, sends them to Amplitude, retries, flushes on shutdown | Use an existing Amplitude SDK, or write about 200 lines against HTTP V2 |
| **Instrumentation** | Watches the MCP server, resolves identity and context, decides what fires | Depends on which hooks your MCP SDK gives you |

Build the layers in that order. First send one hand-written event to Amplitude.
Confirm that it lands. Then connect the MCP hooks. This isolates any problem to
one layer.

## Layer 1: delivery

### Use a first-party Amplitude SDK if one exists

Amplitude ships analytics server SDKs for several languages. The
[catalog](https://amplitude.com/docs/sdks) lists them, and it includes Node,
Python, and Java. Use the SDK for your language if the catalog has one. That
SDK already handles batching, retry with backoff, `insert_id` deduplication,
server-zone routing, and flush on shutdown. Your port then only builds the
event dictionaries and calls `track()`. The Node SDK works this way.

### Otherwise, send events to HTTP V2 directly

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

Get these points right at this layer:

- **Send `user_id` or `device_id` on every event.** Amplitude drops an id
  shorter than 5 characters, and it gives no error. Generated fallback ids meet
  this requirement, but validate caller-supplied ids because they are used
  verbatim.
- **Set `time` in milliseconds since epoch.** Set it at the moment the event
  happens. Do not set it at flush time. Your own batching then skews your
  latency analysis and your funnel analysis.
- **Send an `insert_id` on every event.** Use one UUID for each event. This
  makes a retry safe. Amplitude removes a duplicate `insert_id` on the same
  `device_id` for 7 days.
- **Retry `429` and `5xx` with exponential backoff.** Treat `400` as a bug in
  your payload and log it instead. A `400` never succeeds on a retry. A `413`
  means that you must split the batch.
- **Stay inside the limits.** Keep each request under 1 MB and under 2000
  events. Amplitude also throttles at about 30 events per second per device. A
  repeated `tools/list` loop can reach these limits.
- **Send to the correct server zone.** An EU project receives nothing when you
  post to the US endpoint, and it reports no error.
- **Set `library` to a name that identifies your port.** For example, use
  `amplitude-mcp-analytics-go/0.1.0`. This makes your events easier to identify
  later.

### Flush discipline

**Flush your buffer before the process stops.**

Your client holds events in a buffer. Your process can exit before the flush.
A serverless runtime can also freeze before the flush. In both cases you lose
those events. The Node SDK counts unflushed events and warns you at exit.

- **Long-lived servers (stdio, persistent HTTP):** flush on a timer. Also flush
  when the server receives a shutdown signal.
- **Serverless and per-request hosts:** flush before the handler returns. Do
  not depend on a background timer. The runtime can freeze between calls and
  never run that timer. Detect the environment the way the reference
  implementation does. It reads `AWS_LAMBDA_FUNCTION_NAME`, `FUNCTION_TARGET`,
  `WEBSITE_INSTANCE_ID`, and similar variables. Warn when your code tracked
  events but never flushed them.

## Layer 2: MCP instrumentation

### The hook points

The SDK builds every event from five observation points. Check that your MCP
SDK gives you these hooks before you start. Hook availability differs between
SDKs.

| Hook | What you observe | Events it drives |
| -- | -- | -- |
| `initialize` request handler | Client name and version, handshake time | `[MCP] Session Initialized` |
| Transport close | Connection teardown | `[MCP] Session Ended` |
| `tools/list` request handler | Tool count, tool names, duration, errors | `[MCP] Tools Listed` |
| Tool handler wrapper | Arguments, result, duration, errors | `[MCP] Tool Call Response` |
| `tools/call` dispatch failure | Rejections before any handler runs | `[MCP] Tool Call Rejected` |

Most SDKs give you handler registration and some form of middleware. That
covers the first four hooks. The fifth hook needs access to the tool registry
of the server. See [Conformance tiers](#conformance-tiers).

### Rules for every hook

**Never change the behavior of the code that you wrap.** In practice:

- Catch every error that your own tracking code raises. Log the error. Then
  continue. The result of the tool must pass through untouched.
- Emit the failure event **before** you re-raise an error from a handler.
  Re-raise the original error with no changes.
- Never change the text or the structure that you return to the client. A
  redaction hook changes telemetry only.
- Make the tool wrapper a transparent pass-through when nobody instrumented the
  server.

**Replace Node's `AsyncLocalStorage` with the equivalent in your language.**
The reference SDK uses it so a handler can call `setIdentity()` or
`setRationale()` at any call depth without a context parameter. Python has
`contextvars`. Go has `context.Context`. Java has `ScopedValue` and
`ThreadLocal`. C# has `AsyncLocal`. You can also ask the caller for an explicit
context parameter. This choice does not affect conformance.

## What conformance means

The points below must be exact. Downstream charts read these values. Everything
else is an implementation detail.

### 1. Names are byte-exact

Every event name and property name that the SDK emits starts with the prefix
`[MCP] `. **The prefix ends with a space.** `[MCP]Tool Name` and
`[MCP] tool name` are different properties from `[MCP] Tool Name`. Amplitude
creates all three and reports no error. A typo therefore splits one dimension
into two.

Copy the names from the [property index](./events.md#property-index) as string
literals. Define them as constants in one file. Write a test that asserts the
literal values.

### 2. The identity chain

Resolve identity for each request. The first match wins.

| Order | Source | `user_id` | `device_id` |
| -- | -- | -- | -- |
| 1 | Explicit call inside the handler | as supplied | as supplied, else derived from the anchor |
| 2 | Resolver over auth claims | as supplied | as supplied, else derived from the anchor |
| 3 | Static server-level identity | as supplied | as supplied, else derived from the anchor |
| 4 | Correlation anchor | `<anchorType>:<anchorValue>` | `uuidv5(anchorKey)` |
| 5 | Anonymous floor | `anonymous:<deviceId>` | a random UUIDv4 for each request |

The **anchor** is the correlation key that you derive from the transport:

| Transport | Anchor type | Anchor value | `[MCP] Session ID` |
| -- | -- | -- | -- |
| stdio | `process` | `<pid>-<random hex>`, created once for each process | `no-session` |
| Streamable HTTP, session id present | `session-id` | the session id of the transport | the session id |
| Streamable HTTP, stateless, `traceparent` present | `trace` | the 32-hex trace id | `no-session` |
| Streamable HTTP, stateless, no trace | `anonymous` | a random UUID for each request | `no-session` |

Check two details:

- **Do not use a bare pid as the stdio anchor value.** A pid is a small integer,
  and each machine recycles its pids. Two unrelated servers on two hosts can
  draw the same pid. Amplitude then merges them into one user. Add a random
  token for each process.
- **Never invent a session id.** The absence of a session id selects the
  stateless branch. Emit the literal `no-session`.

### 3. How to derive `device_id`

At the anchor level, `device_id` is a **UUIDv5 (RFC 9562 §5.5)** of the anchor
key. It uses this namespace:

```
namespace = f08626eb-3a5c-4f3a-bec2-227ab3178022
name      = "<anchorType>:<anchorValue>"
device_id = uuidv5(namespace, name)
```

**The reason for hashing.** Amplitude needs a `user_id` or a `device_id` on
every event. An MCP server often has neither. There is no login, and on
stateless HTTP nothing survives the request. A random id for each request makes
your unique-device count equal your request count. A hash of a stable anchor
gives the same id for the same session or process every time. It also **stores
nothing**: no lookup table, and nothing to lose on a serverless cold start.

**What the namespace does.** The namespace is an input to the hash. It is not a
field on the event, and it never appears in the ingestion payload. The
namespace controls the *mapping* from an anchor to a `device_id`.

Two implementations can agree on everything else and still use different
namespaces. They then produce two separate device populations from the same
traffic. Nothing on the wire explains why. Run the test vectors below to check
your output.

This is standard UUIDv5, with no changes. Hash the 16 raw bytes of the
namespace, then the UTF-8 name, with SHA-1. Then set the version bits and the
variant bits. Use the UUID library of your language. Do not write the
algorithm yourself. The Node SDK writes it only because that package carries no
runtime dependencies.

First check your library against the published RFC vectors:

| Namespace | Name | Expected |
| -- | -- | -- |
| `6ba7b810-9dad-11d1-80b4-00c04fd430c8` (DNS) | `www.example.com` | `2ed6657d-e927-568b-95e1-2665a8aea6a2` |
| `6ba7b810-9dad-11d1-80b4-00c04fd430c8` (DNS) | `python.org` | `886313e1-3b8a-5372-9b90-0c9aee199e5d` |

Then check your implementation against the vectors below. They use the MCP
analytics namespace above:

| Anchor key | Expected `device_id` |
| -- | -- |
| `session-id:3fa85f64-5717-4562-b3fc-2c963f66afa6` | `18ac030b-d5ba-5b6a-a79f-ad6b992b1ef4` |
| `process:12345-1f0cbd3a6b4e4f0a9c2d7e8f1a2b3c4d` | `ed7a1818-ddbf-5bcc-ba25-db42abe39900` |
| `trace:4bf92f3577b34da6a3ce929d0e0e4736` | `816b1211-5802-5d6a-b69a-0edec8a18103` |

The namespace value matters in two cases. You can move to a first-party SDK
later. You can also run your port next to an official SDK. In both cases the
same namespace keeps the same anchor on the same device across the change,
instead of resetting your whole device population. Any stable namespace of your
own works when neither case applies.

**Do not use one of the four namespaces that RFC 9562 reserves** (DNS, URL,
OID, X.500). A namespace exists to separate domains. A namespace that you own
guarantees that your derivation never collides with another system that hashes
similar names. A reserved constant gives up that guarantee. Choose one random
v4 UUID and then keep it fixed. A later change re-derives every `device_id`
that you have ever sent.

### 4. The skip rule

**Drop an event that reaches the anonymous floor and has no tenant.** Each of
those requests creates a fresh `device_id` that never appears again. Sending
them inflates your unique-user counts and your unique-device counts.

This affects one case only: stateless Streamable HTTP with no identity
configured and no trace context propagated. Give the host an opt-in flag to
send these events as aggregate-only data. Set the flag off by default.

### 5. Measurement conventions

- **Durations** are wall-clock milliseconds, rounded to the nearest integer.
  Measure them with a monotonic clock, not with wall time.
- **Sizes** are the UTF-8 byte length of the **JSON serialization** of the
  value. This is the size of the payload, not the size on the wire. Omit the
  property when the value has no JSON serialization. Do not send `0` instead.
  As a check, `{"q":"héllo"}` serializes to 14 bytes.
- **Tenant** goes on the Amplitude `groups` field as `{groupType: groupValue}`.
  Never send it as an event property.

### 6. Closed vocabularies

Emit these values exactly as written. Do not add new members. Describe a
host-specific failure through the free-form `[MCP] Error Code` instead.

| Property | Allowed values |
| -- | -- |
| `[MCP] Transport` | `stdio`, `streamable-http` |
| `[MCP] Anchor Type` | `process`, `session-id`, `trace`, `anonymous` |
| `[MCP] Error Type` | `returned_error`, `thrown_exception`, `timeout`, `transport_error`, `protocol_error`, `rate_limited`, `unknown` |
| `[MCP] Rejection Reason` | `unknown_tool`, `disabled_tool`, `schema_validation`, `unrecognized` |

Two sentinel values are literals. Use `no-session` for `[MCP] Session ID`. Use
`unknown` for `[MCP] Client Name` and for `[MCP] User Agent`.

Map the error classification onto the error model of your language, not onto
Node's model. Use `timeout` for your cancellation error. Use `transport_error`
for your network error class. The Node SDK matches `ECONNREFUSED`,
`ECONNRESET`, `ENOTFOUND`, `ETIMEDOUT`, `EPIPE`, and `EAI_AGAIN`. Use
`rate_limited` for any failure that carries HTTP 429.

### 7. Caps and property precedence

| Value | Cap |
| -- | -- |
| `[MCP] Tool Names` | 100 entries, then set `[MCP] Tool Names Truncated` (`[MCP] Tool Count` still reports the true total) |
| `[MCP] Attempted Tool Name` | 200 characters |
| `[MCP] Rationale` | 1000 characters |

Properties merge in a fixed order. A later source overwrites an earlier one:

```
reserved (SDK-derived)  <  extra (context bag)  <  properties (per call)
```

On the default events, the SDK sends its own outcome values as per-call
`properties`. An `extra` key with the same name therefore cannot overwrite them.

## Conformance tiers

You do not have to build all of it. Ship in the order below.

**Tier 1: required.** Build `[MCP] Tool Call Response`, the
[shared properties](./events.md#shared-properties), and the identity chain.
Tier 1 gives you adoption, tool popularity, latency, error rate, and
segmentation by client. Tier 1 alone is a working integration.

**Tier 2: lifecycle.** Add `[MCP] Session Initialized`, `[MCP] Session Ended`,
and `[MCP] Tools Listed`. These give you session counts, session durations, and
discovery behavior. They reuse the context and identity code from Tier 1.

**Tier 3: optional.** Add `[MCP] Tool Call Rejected`, rationale capture, error
message sanitization, and custom events.

`[MCP] Tool Call Rejected` has two requirements that the other events do not.
It reads the tool registry of the server to separate `unknown_tool` from
`disabled_tool`. It also matches `schema_validation` from the *prose* of the
MCP SDK error. The MCP SDK has reworded that text across versions.

Skip this event when your MCP SDK does not expose its registry. Do not guess a
`[MCP] Rejection Reason`. An implementation that emits only `unrecognized` is a
valid partial implementation.

**Do not emit a default event that you cannot populate honestly.**

## Golden fixture

Compare your output against the fixture below. It shows a successful tool call
over legacy Streamable HTTP, with an identity resolved from OAuth. Every Tier 1
implementation should produce this shape.

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

Complete this list before you rely on the data.

1. **Check the UUIDv5 vectors.** Run the RFC pair and the anchor-key table
   above. All five must pass.
2. **Assert the property names as literals in a test.** Include the trailing
   space in `[MCP] `.
3. **Land one real event.** Send it to a scratch Amplitude project. Confirm
   that it appears, and that `user_id` or `device_id` holds a value. Confirm
   the property types: a number as a number, a boolean as a boolean, and
   `[MCP] Tool Names` as an array of strings. Check that a number does not
   arrive as a string.
4. **Test the failure path.** Assert that a handler that throws still produces
   the event. Assert that it also re-raises the original error with no changes.
5. **Contain your tracking errors.** Force your delivery layer to throw. Assert
   that the tool call still succeeds.
6. **Test the skip rule.** A stateless request with no identity and no tenant
   must emit nothing by default.
7. **Test anchor stability.** Two calls in one session must share a
   `device_id`. Two separate processes must not share one.
8. **Test the flush.** Confirm that a flush happens on shutdown. Confirm that
   a flush happens before the handler returns under serverless.
9. **Run a side-by-side comparison if you can.** Run your port and the Node SDK
   against equivalent servers. Compare the event payloads.

## Common pitfalls

- **Do not drop the trailing space in the `[MCP] ` prefix.** This splits your
  taxonomy, and Amplitude reports no error.
- **Do not measure duration with wall-clock time.** Use a monotonic clock. An
  NTP adjustment can otherwise produce a negative duration.
- **Do not send sizes as bytes on the wire.** The specification asks for the
  byte length of the JSON serialization.
- **Do not emit the anonymous floor.** It inflates your unique counts with ids
  that never appear again. Follow the skip rule.
- **Do not use a bare pid as the stdio anchor.** It merges unrelated installs
  into one user.
- **Do not omit `insert_id`.** Every retry then becomes a duplicate event.
- **Do not let a tracking failure escape** into the control flow of the tool.
- **Do not skip the flush under serverless.** Local runs emit events and
  production runs emit none.
- **Do not put the tenant in `event_properties`.** It belongs on `groups`.
- **Do not set `time` at flush.** Set it at the moment of the event.
- **Do not send the events of an EU project to the US endpoint.** You lose the
  data, and Amplitude reports no error.
- **Do not emit a free-text error message without a filter.**
  `[MCP] Error Message` is the one error property that carries text the SDK did
  not write. A validation failure can quote the argument value that failed.
  Give the host a sanitizer hook. Make the hook fail closed: a sanitizer that
  throws drops the property, and never falls back to the raw message. Never
  change the message that the client receives.

## Staying in sync

- [`events.md`](./events.md) is the normative specification. Watch this
  repository for releases.
- The contract follows semver at the package level. An additive change, such as
  a new event or a new property, is a minor release. The release notes call out
  every breaking change. The derivation of `device_id` has changed once, in a
  major release.
- Read the Node or the Python implementation when the specification is unclear.
  If you had to read the source to answer a question, the specification has a
  gap:
  [open an issue](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/issues).
- Tell Amplitude that you built a port.
