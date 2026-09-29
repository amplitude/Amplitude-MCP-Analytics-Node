# MCP playground

A local MCP server that uses this SDK, for pointing a real client at it. By default it does not send anything to Amplitude. Three logs are written next to this file:

- `mcp-requests.ndjson` — each JSON-RPC message the client sends, the HTTP response to it, and session open/close.
- `sdk-track.ndjson` — each `track()` call the SDK makes, before `@amplitude/analytics-node` batches it.
- `events.ndjson` — each HTTP V2 body `@amplitude/analytics-node` would post to Amplitude.

A one-line summary of each is printed on stderr. stdout is left for the stdio protocol.

The request log intentionally contains tool arguments and the client's `_meta` object as sent. Clients put conversation ids, workspace paths, and similar context there. These files are gitignored. Never commit them or expose them publicly.

The server has two tools:

- `echo` — returns the `message` you pass. If you also pass `rationale`, that text is recorded as `[MCP] Rationale`.
- `whoami` — returns `playground-user` and sends that as the Amplitude `user_id` for the call.

Connecting is enough to emit `[MCP] Session Initialized` and, once the client lists tools, `[MCP] Tools Listed`. A tool call emits `[MCP] Tool Call Response`. Closing a stdio process, or this HTTP server's session, emits `[MCP] Session Ended`.

Watch the logs while you use a client:

```bash
tail -f examples/playground/mcp-requests.ndjson
tail -f examples/playground/sdk-track.ndjson
tail -f examples/playground/events.ndjson
```

## Following one tool call

`pnpm playground:chain` prints one block per `tools/call` in the most recent run, joining the three logs:

```bash
pnpm playground:chain            # latest run
pnpm playground:chain --run <id> # a specific run
pnpm playground:chain --json     # the same rows as JSON
```

Each block shows the request (`seq`, time, JSON-RPC id, tool, session id), its HTTP response, the correlation ids found in the request's `_meta`, the matching `track()` record, the matching ingested event, and the correlation-shaped properties on that event. It flags a `_meta` id that has no matching event property, a request with no `track()` record, and a `track()` record that was never ingested.

`_meta` discovery lists any key, at the top level or inside nested objects, whose name matches `/(conversation|thread|session|turn|run|job|call|item)_?id/i`. Only the key path and value are printed.

### Run boundary

Every process writes `{"type":"run_started","at":<epoch ms>,"pid":...,"transport":...,"runId":"<uuid>"}` as its first line in each log, then puts the same `runId` on every later line. Logs are append-only across runs; the marker is how one run is told apart from the next.

### Request log fields

Requests keep the original fields (`transport`, `httpMethod`, `message`, `raw`) and add:

| Field | Meaning |
| -- | -- |
| `type` | `request`, `response`, `session_opened`, `session_closed`, `initialize_with_existing_session`, or `run_started` |
| `runId` | The process that wrote the line |
| `seq` | Per-process counter. A request, its response, and any `track()` calls it caused share one value |
| `receivedAt` | Epoch ms when the request arrived |
| `path` | HTTP only. URL path |
| `headers` | HTTP only. Only `mcp-session-id`, `mcp-protocol-version`, `user-agent`, `content-type`, `accept`, `last-event-id`. `authorization`, `cookie`, and every other header are never logged |
| `sessionId` | The `mcp-session-id` request header, when present |

A `response` line carries `status`, `durationMs`, the `mcp-session-id` response header as `sessionId`, `sse: true` when the body was an event stream (only the status is recorded for those), and `errorBody` for non-2xx JSON responses, truncated to 4 KB.

The HTTP server holds one transport and therefore one session. A second `initialize` while that session exists is logged as `initialize_with_existing_session` and answered `400` by the transport.

A request line looks like:

```json
{"type":"request","transport":"streamable-http","runId":"3f0c…","seq":5,"receivedAt":1727640000123,"path":"/mcp","headers":{"mcp-session-id":"8f4c…","content-type":"application/json"},"sessionId":"8f4c…","httpMethod":"POST","message":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}}
```

### `sdk-track.ndjson`

One line per SDK `track()` call: `{runId, seq, at, requestSeq, sessionId, event_type, user_id, device_id, event_properties}`. `requestSeq` is the `seq` of the HTTP request being handled when the SDK called `track()`, and `sessionId` is that request's session. Both are `null` for calls outside a request, such as `[MCP] Session Ended` on transport close, and for stdio. The wrapper only observes; it does not change the event or what is sent.

### `events.ndjson`

One HTTP V2 body per line (`api_key`, `events`, `options`), plus `runId` and `receivedAt` added by the sink. With the sink, `api_key` is the fake value `local-test-key`. The SDK does not set `insert_id` or `time`; `@amplitude/analytics-node` adds them after `track()`, so the chain viewer joins a `track()` record to an ingested event by event type, user id, tool name, and closest `time`.

This server has no auth and the tools do not read real data.

## Streamable HTTP

You start the process, then point a client at it:

```bash
pnpm playground:http
```

It listens on `http://127.0.0.1:8787/mcp`.

MCP Inspector can call the tools without an LLM. Start the server, then run `npx @modelcontextprotocol/inspector` and connect to that URL.

A client config uses `url` instead of a command:

```json
{
  "mcpServers": {
    "amplitude-playground": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

This process is the one to publish later. The log files stay on the machine that runs the server; do not expose them on a public URL.

## stdio

Cursor, Claude Desktop, and Claude Code spawn the process. stdout is the MCP protocol, so both logs are files (and a short summary on stderr), not the terminal.

```json
{
  "mcpServers": {
    "amplitude-playground": {
      "command": "pnpm",
      "args": ["playground:stdio"],
      "cwd": "/absolute/path/to/this/repo"
    }
  }
}
```

Cursor: `.cursor/mcp.json` or the global MCP settings. Claude Desktop: `claude_desktop_config.json`. From Claude Code, in this repo:

```bash
claude mcp add amplitude-playground -- pnpm playground:stdio
```

Then ask the client to call a tool, for example: "Use the echo tool on the amplitude-playground server to echo hello." The session and tools-listed events are already in the log when the client connects.

## Send to Amplitude instead

Leave `AMPLITUDE_API_KEY` unset to use the sink. Export a project API key and the same server delivers to Amplitude's HTTP V2 endpoint instead of writing `events.ndjson`. Client requests and `track()` calls are still logged.

```bash
AMPLITUDE_API_KEY=your-project-key pnpm playground:http
```

`pnpm playground` prints the script names.
