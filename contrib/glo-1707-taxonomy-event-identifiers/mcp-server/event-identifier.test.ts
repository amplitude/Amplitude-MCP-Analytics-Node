import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildEventNameIndex,
  enrichTaxonomyEventRow,
  isJsonHostileEventName,
  jsonEscapedEventName,
  normalizeDeleteTargets,
  normalizeEventUpdates,
  normalizeLegacyUpdateMap,
  parseJsonEscapedEventName,
  resolveEventName,
  TaxonomyEventIdentifierError,
} from './event-identifier.ts';

const REPLACEMENT = '\uFFFD';
const JSON_LIKE = '{"feature":"flag","enabled":true}';
const QUOTED = 'save "chart" action';
const BACKSLASH = 'path\\to\\event';
const CONTROL = 'event\u0007bell';

const FIXTURE_ROWS = [
  { id: 'evt-1', name: 'normal_event' },
  { id: 'evt-2', name: `broken${REPLACEMENT}name` },
  { id: 'evt-3', name: JSON_LIKE },
  { id: 'evt-4', name: QUOTED },
  { id: 'evt-5', name: BACKSLASH },
  { id: 'evt-6', name: CONTROL },
];

function fixtureIndex() {
  return buildEventNameIndex(FIXTURE_ROWS);
}

describe('jsonEscapedEventName / parseJsonEscapedEventName', () => {
  const cases = [
    ['normal_event', '"normal_event"'],
    [`broken${REPLACEMENT}name`, `"broken${REPLACEMENT}name"`],
    [JSON_LIKE, '"{\\"feature\\":\\"flag\\",\\"enabled\\":true}"'],
    [QUOTED, '"save \\"chart\\" action"'],
    [BACKSLASH, '"path\\\\to\\\\event"'],
    [CONTROL, '"event\\u0007bell"'],
  ] as const;

  for (const [name, escaped] of cases) {
    it(`round-trips ${escaped}`, () => {
      assert.equal(jsonEscapedEventName(name), escaped);
      assert.equal(parseJsonEscapedEventName(escaped), name);
    });
  }

  it('rejects non-string JSON values', () => {
    assert.throws(
      () => parseJsonEscapedEventName('{"not":"a string wrapper"}'),
      TaxonomyEventIdentifierError,
    );
  });
});

describe('enrichTaxonomyEventRow', () => {
  it('adds nameJsonEscaped without mutating source row', () => {
    const row = { id: 'evt-3', name: JSON_LIKE, category: 'Product' };
    const enriched = enrichTaxonomyEventRow(row);

    assert.equal(enriched.id, 'evt-3');
    assert.equal(enriched.category, 'Product');
    assert.equal(enriched.nameJsonEscaped, jsonEscapedEventName(JSON_LIKE));
    assert.equal(parseJsonEscapedEventName(enriched.nameJsonEscaped), JSON_LIKE);
  });
});

describe('resolveEventName', () => {
  const index = fixtureIndex();

  it('resolves by stable id for U+FFFD names', () => {
    assert.equal(
      resolveEventName({ id: 'evt-2' }, index),
      `broken${REPLACEMENT}name`,
    );
  });

  it('resolves by exact name for legacy callers', () => {
    assert.equal(resolveEventName({ name: JSON_LIKE }, index), JSON_LIKE);
  });

  it('prefers id over mismatched name', () => {
    assert.equal(
      resolveEventName({ id: 'evt-3', name: 'stale_name' }, index),
      JSON_LIKE,
    );
  });

  it('throws for unknown id', () => {
    assert.throws(
      () => resolveEventName({ id: 'missing' }, index),
      /Unknown taxonomy event id/,
    );
  });
});

describe('normalizeEventUpdates', () => {
  const index = fixtureIndex();

  it('resolves id-based updates without requiring raw name in tool JSON keys', () => {
    const updates = normalizeEventUpdates(
      [{ id: 'evt-2', description: 'cleanup candidate' }],
      index,
    );

    assert.deepEqual(updates, [
      {
        id: 'evt-2',
        description: 'cleanup candidate',
        resolvedName: `broken${REPLACEMENT}name`,
      },
    ]);
  });

  it('supports JSON-like names via id', () => {
    const updates = normalizeEventUpdates(
      [{ id: 'evt-3', newName: 'feature_flag_toggled' }],
      index,
    );

    assert.equal(updates[0]?.resolvedName, JSON_LIKE);
  });
});

describe('normalizeLegacyUpdateMap', () => {
  const index = fixtureIndex();

  it('preserves legacy map shape while attaching ids', () => {
    const updates = normalizeLegacyUpdateMap(
      {
        [QUOTED]: { description: 'quoted event' },
      },
      index,
    );

    assert.equal(updates[0]?.id, 'evt-4');
    assert.equal(updates[0]?.name, QUOTED);
    assert.equal(updates[0]?.description, 'quoted event');
  });
});

describe('normalizeDeleteTargets', () => {
  const index = fixtureIndex();

  it('deletes by id array without embedding hostile names in tool args', () => {
    assert.deepEqual(
      normalizeDeleteTargets({ ids: ['evt-2', 'evt-3'] }, index),
      [`broken${REPLACEMENT}name`, JSON_LIKE],
    );
  });

  it('merges ids and legacy names', () => {
    assert.deepEqual(
      normalizeDeleteTargets({ ids: ['evt-1'], names: [BACKSLASH] }, index),
      ['normal_event', BACKSLASH],
    );
  });
});

describe('isJsonHostileEventName', () => {
  it('flags U+FFFD and JSON-like names', () => {
    assert.equal(isJsonHostileEventName(`x${REPLACEMENT}y`), true);
    assert.equal(isJsonHostileEventName(JSON_LIKE), true);
    assert.equal(isJsonHostileEventName(QUOTED), true);
    assert.equal(isJsonHostileEventName(BACKSLASH), true);
    assert.equal(isJsonHostileEventName(CONTROL), true);
    assert.equal(isJsonHostileEventName('plain_event'), false);
  });
});
