/**
 * Reference implementation for taxonomy event identification (GLO-1707).
 *
 * Port to: amplitude/javascript → server/packages/mcp-server/src/tools/internal/taxonomy/
 *
 * Problem: name-keyed mutation maps break when ingested event names contain
 * U+FFFD or JSON-hostile characters. Models drop/normalize glyphs or emit
 * invalid tool-call JSON, so the next mutation no longer exact-matches.
 *
 * Contract:
 * 1. Reads return stable Orbit `id` plus `nameJsonEscaped` for copy-safe fallback.
 * 2. Writes accept `id` (preferred) or exact `name`; name-keyed maps remain for compat.
 */

/** Opaque Orbit taxonomy event id (not necessarily equal to ingested name). */
export type TaxonomyEventId = string;

export interface TaxonomyEventRef {
  /** Preferred stable identifier from get_events / manage_amp_events reads. */
  id?: TaxonomyEventId;
  /** Legacy identifier — exact ingested event type string. */
  name?: string;
}

export interface TaxonomyEventReadRow {
  id: TaxonomyEventId;
  name: string;
  /** JSON.stringify(name) — safe for models to copy into tool-call JSON literals. */
  nameJsonEscaped: string;
}

export interface TaxonomyEventUpdateInput extends TaxonomyEventRef {
  description?: string | null;
  displayName?: string | null;
  category?: string | null;
  newName?: string | null;
  isHiddenFromDropdowns?: boolean;
  isHiddenFromPathfinder?: boolean;
  isHiddenFromTimeline?: boolean;
  isHiddenFromPersonaResults?: boolean;
}

export type TaxonomyEventUpdateMap = Record<string, Omit<TaxonomyEventUpdateInput, 'id' | 'name'>>;

export class TaxonomyEventIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxonomyEventIdentifierError';
  }
}

/** Produce a JSON-escaped literal models can round-trip with JSON.parse. */
export function jsonEscapedEventName(name: string): string {
  return JSON.stringify(name);
}

/** Decode a copy-safe escaped name from tool output. */
export function parseJsonEscapedEventName(nameJsonEscaped: string): string {
  try {
    const parsed: unknown = JSON.parse(nameJsonEscaped);
    if (typeof parsed !== 'string') {
      throw new TaxonomyEventIdentifierError(
        'nameJsonEscaped must decode to a string event name',
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof TaxonomyEventIdentifierError) {
      throw error;
    }
    throw new TaxonomyEventIdentifierError(
      `Invalid nameJsonEscaped value: ${nameJsonEscaped}`,
    );
  }
}

/** Attach copy-safe encoding to a taxonomy event row returned from reads. */
export function enrichTaxonomyEventRow<T extends { id: TaxonomyEventId; name: string }>(
  row: T,
): T & Pick<TaxonomyEventReadRow, 'nameJsonEscaped'> {
  return {
    ...row,
    nameJsonEscaped: jsonEscapedEventName(row.name),
  };
}

export interface EventNameIndex {
  idToName: ReadonlyMap<TaxonomyEventId, string>;
  nameToId: ReadonlyMap<string, TaxonomyEventId>;
}

export function buildEventNameIndex(
  rows: ReadonlyArray<{ id: TaxonomyEventId; name: string }>,
): EventNameIndex {
  const idToName = new Map<TaxonomyEventId, string>();
  const nameToId = new Map<string, TaxonomyEventId>();

  for (const row of rows) {
    idToName.set(row.id, row.name);
    nameToId.set(row.name, row.id);
  }

  return { idToName, nameToId };
}

/**
 * Resolve a mutation ref to the exact ingested event name required by editEventsV2.
 * Prefers `id` when present.
 */
export function resolveEventName(
  ref: TaxonomyEventRef,
  index: EventNameIndex,
): string {
  if (ref.id) {
    const name = index.idToName.get(ref.id);
    if (!name) {
      throw new TaxonomyEventIdentifierError(`Unknown taxonomy event id: ${ref.id}`);
    }
    return name;
  }

  if (ref.name) {
    if (!index.nameToId.has(ref.name)) {
      throw new TaxonomyEventIdentifierError(
        `Unknown taxonomy event name: ${jsonEscapedEventName(ref.name)}`,
      );
    }
    return ref.name;
  }

  throw new TaxonomyEventIdentifierError(
    'Event mutation requires `id` or exact `name`',
  );
}

/** Normalize legacy name-keyed update maps into id-resolved rows. */
export function normalizeLegacyUpdateMap(
  updates: TaxonomyEventUpdateMap,
  index: EventNameIndex,
): TaxonomyEventUpdateInput[] {
  return Object.entries(updates).map(([eventName, patch]) => ({
    name: eventName,
    ...patch,
    ...(() => {
      const resolvedName = resolveEventName({ name: eventName }, index);
      const id = index.nameToId.get(resolvedName);
      return id ? { id } : {};
    })(),
  }));
}

/** Normalize array-based updates (preferred write shape). */
export function normalizeEventUpdates(
  updates: ReadonlyArray<TaxonomyEventUpdateInput>,
  index: EventNameIndex,
): Array<TaxonomyEventUpdateInput & { resolvedName: string }> {
  return updates.map((update) => ({
    ...update,
    resolvedName: resolveEventName(update, index),
  }));
}

/** Normalize delete targets from ids and/or legacy name arrays. */
export function normalizeDeleteTargets(
  input: { ids?: ReadonlyArray<TaxonomyEventId>; names?: ReadonlyArray<string> },
  index: EventNameIndex,
): string[] {
  const resolved = new Set<string>();

  for (const id of input.ids ?? []) {
    resolved.add(resolveEventName({ id }, index));
  }

  for (const name of input.names ?? []) {
    resolved.add(resolveEventName({ name }, index));
  }

  if (resolved.size === 0) {
    throw new TaxonomyEventIdentifierError(
      'Delete requires at least one event `id` or exact `name`',
    );
  }

  return [...resolved];
}

/** Whether a name is risky to use as a JSON object key in tool args. */
export function isJsonHostileEventName(name: string): boolean {
  if (name.includes('\uFFFD')) {
    return true;
  }

  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return /[{}"\\]/.test(name);
}
