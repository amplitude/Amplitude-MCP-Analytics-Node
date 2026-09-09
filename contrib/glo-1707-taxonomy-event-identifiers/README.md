# GLO-1707: Taxonomy MCP event identifier contract

This directory is a **porting reference** for
`amplitude/javascript` → `server/packages/mcp-server/`. It is not part of the
`@amplitude/mcp-analytics` public API.

## Problem

Custom agents cannot reliably mutate tracking-plan events when ingested names
contain U+FFFD or JSON-hostile characters. Taxonomy MCP tools currently key
mutations on exact ingested names in JSON object keys (`update_event` maps,
`delete_events` `eventTypes[]`). Models drop/normalize U+FFFD or emit invalid
tool-call JSON for names that look like JSON, so the next call no longer
exact-matches.

## Contract

### Reads (`get_events`, `manage_amp_events` read, `get_amp_taxonomy`)

Return for each event:

| Field | Purpose |
| --- | --- |
| `id` | Stable Orbit taxonomy event id |
| `name` | Exact ingested event type |
| `nameJsonEscaped` | `JSON.stringify(name)` for interim copy-safe fallback |

### Writes (`update_event`, `manage_amp_events` update)

Preferred:

```json
{ "updates": [{ "id": "evt-2", "description": "…" }] }
```

Legacy name-keyed maps remain for backwards compatibility but must not be used
for JSON-hostile names.

### Deletes (`delete_events`, `manage_amp_events` delete)

Preferred:

```json
{ "ids": ["evt-2", "evt-3"] }
```

`eventTypes` / `names` remain as legacy aliases.

## Port target

```
server/packages/mcp-server/src/tools/internal/taxonomy/
  event-identifier.ts     ← from mcp-server/event-identifier.ts
  get-events.ts           ← return id + nameJsonEscaped from GraphQL
  update-event.ts         ← accept id / updates[]
  delete-events.ts        ← accept ids[]
```

GraphQL `editEventsV2` continues to receive exact `eventType` strings
internally; MCP tool args should resolve `id` → name before calling Orbit.

## Tests

```bash
cd contrib/glo-1707-taxonomy-event-identifiers/mcp-server
node --experimental-strip-types --test event-identifier.test.ts
```

Regression coverage includes U+FFFD, JSON-like names, quotes, backslashes, and
control characters.

## Related marketplace updates (separate PR)

Skill guidance updates for `plugins/amplitude/skills/taxonomy/SKILL.md` belong
in `amplitude/mcp-marketplace` once write access is available.
