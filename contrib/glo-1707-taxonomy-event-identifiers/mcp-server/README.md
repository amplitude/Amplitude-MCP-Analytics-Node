# Taxonomy event identifier reference (GLO-1707)

Reference implementation for fixing taxonomy MCP name round-trip failures when
ingested event names contain U+FFFD or JSON-hostile characters.

## Port target

```
amplitude/javascript
  server/packages/mcp-server/src/tools/internal/taxonomy/
    event-identifier.ts          ← copy/adapt from here
    get-events.ts                ← return id + nameJsonEscaped
    update-event.ts              ← accept id / updates[]
    delete-events.ts             ← accept ids[]
    manage-amp-events.ts         ← wire consolidated tool to helpers above
```

GraphQL integration (`editEventsV2`) should continue to receive exact ingested
`eventType` strings internally. MCP tool args should stop requiring models to
place hostile names in JSON object keys.

## Read contract (`get_events` / `manage_amp_events` read)

Each event row should include:

| Field | Type | Purpose |
| --- | --- | --- |
| `id` | `string` | Stable Orbit taxonomy event id |
| `name` | `string` | Exact ingested event type |
| `nameJsonEscaped` | `string` | `JSON.stringify(name)` for copy-safe fallback |

## Write contract (`update_event` / `manage_amp_events` update)

Preferred input shape:

```json
{
  "projectId": "123",
  "updates": [
    { "id": "evt-2", "description": "…" },
    { "id": "evt-3", "newName": "renamed_event" }
  ]
}
```

Legacy name-keyed maps remain supported for backwards compatibility, but
callers must not use them for `isJsonHostileEventName(name)` rows — require
`id` instead.

## Delete contract (`delete_events` / `manage_amp_events` delete)

```json
{
  "projectId": "123",
  "ids": ["evt-2", "evt-3"]
}
```

`eventTypes` / `names` arrays remain as legacy aliases.

## Run tests

From this directory:

```bash
node --experimental-strip-types --test event-identifier.test.ts
```
