# MCP playground

A local MCP server that uses this SDK, for pointing a real client at it. By default it does not send anything to Amplitude. Two logs are written next to this file:

- `mcp-requests.ndjson` — each JSON-RPC message the client sends, including tool arguments.
- `events.ndjson` — each HTTP V2 body `@amplitude/analytics-node` would post to Amplitude.

A one-line summary of both is printed on stderr. stdout is left for the stdio protocol.

The server has three tools:

- `echo` — returns the `message` you pass. If you also pass `rationale`, that text is recorded as `[MCP] Rationale`.
- `whoami` — returns `playground-user` and sends that as the Amplitude `user_id` for the call. `setIdentity` changes the user id partway through the session. On stdio there is no session id, so those two user ids are two episodes rather than one session.
- `submit_feedback` — records whether a result helped. A call emits `[MCP] Feedback Submitted` and does not also emit `[MCP] Tool Call Response`. The server instructions name this tool so the agent knows when to call it.

Every event carries an `org id` group. The value is `PLAYGROUND_ORG_ID` when that variable is set, and `0` otherwise. Keep it numeric.

Connecting is enough to emit `[MCP] Session Initialized` and, once the client lists tools, `[MCP] Tools Listed`. A call to `echo` or `whoami` emits `[MCP] Tool Call Response`. A call to `submit_feedback` emits `[MCP] Feedback Submitted`. Closing a stdio process, or this HTTP server's session, emits `[MCP] Session Ended`.

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

You start the process, then point a client at it. The `playground:*` scripts run TypeScript with `node --experimental-strip-types`, which needs Node 22.6 or later.

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

## Feedback cases

`examples/playground/feedback-cases.ts` is the list of user messages and the `submit_feedback` arguments an agent should send. The playground test applies those arguments and checks the event. It does not run an agent. Point a host at this server to see whether the agent calls the tool on its own.

Start with echo, so the reaction is about a result from this server:

> Use the echo tool on the amplitude-playground server to echo hello.

Then send one message:

| Message | What should happen |
| -- | -- |
| thanks, that's it | Calls `submit_feedback` with `helpful: true` and `solicited: false` |
| perfect | Same, `helpful: true` |
| that's wrong | `helpful: false`, `reason: "wrong_result"` |
| this didn't work | `helpful: false`, `reason: "other"` |
| file feedback | Asks what to record. If you answer "it was wrong", calls with `helpful: false`, `reason: "wrong_result"`, `solicited: true` |
| can you echo that again? | Does not call `submit_feedback` |
| what was the message you echoed? (after a feedback call already succeeded) | Does not call it again. The tool result tells the agent not to ask unless you bring feedback up |

For each host, write down three things: whether the call happened, whether an approval dialog appeared, and whether the agent asked "was this helpful?" on its own before you reacted. A missing proactive ask is worth recording. Reactive calls are the ones that have to work.

Hosts: Claude Code, Cursor, Codex, ChatGPT, VS Code.

## Send to Amplitude instead

Leave `AMPLITUDE_API_KEY` unset to use the sink. Export a project API key and the same server delivers to Amplitude's HTTP V2 endpoint instead of writing `events.ndjson`. Client requests are still appended to `mcp-requests.ndjson`.

```bash
AMPLITUDE_API_KEY=your-project-key pnpm playground:http
```

`pnpm playground` prints the two script names.
