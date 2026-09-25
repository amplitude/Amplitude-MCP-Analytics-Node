# MCP playground

A local MCP server that uses this SDK, for pointing a real client at it. By default it does not send anything to Amplitude. Two logs are written next to this file:

- `mcp-requests.ndjson` — each JSON-RPC message the client sends, including tool arguments.
- `events.ndjson` — each HTTP V2 body `@amplitude/analytics-node` would post to Amplitude.

A one-line summary of both is printed on stderr. stdout is left for the stdio protocol.

The server has two tools:

- `echo` — returns the `message` you pass. If you also pass `rationale`, that text is recorded as `[MCP] Rationale`.
- `whoami` — returns `playground-user` and sends that as the Amplitude `user_id` for the call.

Connecting is enough to emit `[MCP] Session Initialized` and, once the client lists tools, `[MCP] Tools Listed`. A tool call emits `[MCP] Tool Call Response`. Closing a stdio process, or this HTTP server's session, emits `[MCP] Session Ended`.

Watch both logs while you use a client:

```bash
tail -f examples/playground/mcp-requests.ndjson
tail -f examples/playground/events.ndjson
```

A request line looks like:

```json
{"transport":"streamable-http","httpMethod":"POST","message":{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello"}}}}
```

An ingestion line is one HTTP V2 body (`api_key`, `events`, `options`). With the sink, `api_key` is the fake value `local-test-key`. Tool arguments are stored in the request log. This server has no auth and the tools do not read real data.

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

Leave `AMPLITUDE_API_KEY` unset to use the sink. Export a project API key and the same server delivers to Amplitude's HTTP V2 endpoint instead of writing `events.ndjson`. Client requests are still appended to `mcp-requests.ndjson`.

```bash
AMPLITUDE_API_KEY=your-project-key pnpm playground:http
```

`pnpm playground` prints the two script names.
