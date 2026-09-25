# MCP playground

A local MCP server that uses this SDK, for pointing a real client at it. By default it does not send anything to Amplitude. `@amplitude/analytics-node` posts each batch at a local HTTP V2 sink, which appends the request body to `events.ndjson` and prints a one-line summary on stderr.

The server has two tools:

- `echo` — returns the `message` you pass. If you also pass `rationale`, that text is recorded as `[MCP] Rationale`.
- `whoami` — returns `playground-user` and sends that as the Amplitude `user_id` for the call.

Connecting is enough to emit `[MCP] Session Initialized` and, once the client lists tools, `[MCP] Tools Listed`. A tool call emits `[MCP] Tool Call Response`. Closing a stdio process, or this HTTP server's session, emits `[MCP] Session Ended`.

Watch the log while you use a client:

```bash
tail -f examples/playground/events.ndjson
```

Each line is one ingestion body (`api_key`, `events`, `options`). With the sink, `api_key` is the fake value `local-test-key`.

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

This process is the one to publish later. The log file stays on the machine that runs the server; do not expose `events.ndjson` on a public URL.

## stdio

Cursor, Claude Desktop, and Claude Code spawn the process. stdout is the MCP protocol, so the payload log is the file above (and a short summary on stderr), not the terminal.

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

Leave `AMPLITUDE_API_KEY` unset to use the sink. Export a project API key and the same server delivers to Amplitude's HTTP V2 endpoint and does not write the log file:

```bash
AMPLITUDE_API_KEY=your-project-key pnpm playground:http
```

`pnpm playground` prints the two script names.
