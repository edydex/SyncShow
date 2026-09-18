'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  COMMUNITY_SERVICE_PLAN_KIND,
  COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  COMMUNITY_SERVICE_PLAN_SCHEMA_VERSIONS,
  COMMUNITY_SERVICE_PLAN_STATUSES,
  CommunityServicePlanError,
  MAX_COMMUNITY_SERVICE_PLAN_ITEMS,
  MAX_COMMUNITY_SERVICE_PLAN_LINKED_READING_VERSES,
  communityServicePlanRevision,
  normalizeCommunityServicePlan,
  normalizeCommunityServicePlanEnvelope,
  normalizeCommunityServicePlanPage,
  parseCommunityServicePlanSource,
  serializeCommunityServicePlan,
  validateCommunityServicePlanSource
} = require('../src/services/community/CommunityServicePlan');

const conformanceFixturePath = path.join(
  __dirname,
  'fixtures',
  'community-service-plan-conformance-v1.json'
);
const conformanceFixtureBytes = fs.readFileSync(conformanceFixturePath);
const conformanceFixture = JSON.parse(conformanceFixtureBytes.toString('utf8'));
const conformanceV2FixturePath = path.join(
  __dirname,
  'fixtures',
  'community-service-plan-conformance-v2.json'
);
const conformanceV2FixtureBytes = fs.readFileSync(conformanceV2FixturePath);
const conformanceV2Fixture =
  JSON.parse(conformanceV2FixtureBytes.toString('utf8'));

function plan(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: COMMUNITY_SERVICE_PLAN_KIND,
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Communion this week.\nSound check at 09:45.',
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }, {
      id: 'song-grace',
      kind: 'song',
      title: 'Grace Alone',
      syncId: 'family-grace-alone',
      expectedRevision: 'a'.repeat(64),
      expectedSyncVersion: 7
    }, {
      id: 'reading',
      kind: 'scripture',
      title: 'Ephesians 3:14–21',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      translationId: 'BSB'
    }, {
      id: 'sermon-prayer',
      kind: 'sermon',
      title: 'The Prayer That Transforms the Church',
      syncId: 'sermon-prayer',
      expectedRevision: 'b'.repeat(64),
      expectedSyncVersion: 4
    }],
    ...overrides
  };
}

function planV2(overrides = {}) {
  const legacy = plan();
  return {
    ...legacy,
    schemaVersion: 2,
    entries: legacy.entries.map(entry => entry.kind === 'scripture'
      ? {
          ...entry,
          sermonReading: {
            sermonEntryId: 'sermon-prayer',
            referenceId: 'primary-eph-3'
          }
        }
      : entry),
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(code, operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof CommunityServicePlanError);
    assert.equal(error.code, code);
    return true;
  });
}

test('fixed cross-repo service-plan fixture preserves canonical bytes and failures', () => {
  assert.equal(
    crypto.createHash('sha256').update(conformanceFixtureBytes).digest('hex'),
    '26b6bd29cd9b8bb97aa32cebbb4b0359bf50ef39dcafea1803dfa1889f578afc'
  );
  assert.equal(conformanceFixture.schemaVersion, 1);
  assert.equal(
    conformanceFixture.kind,
    'syncshow-community-service-plan-conformance'
  );
  const source = serializeCommunityServicePlan(conformanceFixture.plan);
  assert.equal(source, conformanceFixture.canonicalSource);
  assert.equal(
    communityServicePlanRevision(source),
    conformanceFixture.revision
  );
  assert.deepEqual(
    normalizeCommunityServicePlanEnvelope(conformanceFixture.envelope),
    {
      ...conformanceFixture.envelope,
      plan: normalizeCommunityServicePlan(conformanceFixture.plan)
    }
  );
  for (const invalid of conformanceFixture.invalidCases) {
    expectCode(
      invalid.expectedCode,
      () => serializeCommunityServicePlan({
        ...conformanceFixture.plan,
        ...invalid.override
      })
    );
  }
});

test('fixed schema-v2 fixture pins the linked sermon-reading wire contract', () => {
  assert.equal(
    crypto.createHash('sha256').update(conformanceV2FixtureBytes).digest('hex'),
    '16b2bdcda04b35efdbed4561add015bfd1e2a3c9989a2eb1bb52470732345774'
  );
  assert.equal(COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION, 2);
  assert.deepEqual(COMMUNITY_SERVICE_PLAN_SCHEMA_VERSIONS, [1, 2]);
  assert.equal(MAX_COMMUNITY_SERVICE_PLAN_LINKED_READING_VERSES, 8);
  assert.equal(conformanceV2Fixture.schemaVersion, 2);
  assert.equal(
    conformanceV2Fixture.kind,
    'syncshow-community-service-plan-conformance'
  );
  const source = serializeCommunityServicePlan(conformanceV2Fixture.plan);
  assert.equal(source, conformanceV2Fixture.canonicalSource);
  assert.equal(
    communityServicePlanRevision(source),
    conformanceV2Fixture.revision
  );
  assert.deepEqual(
    normalizeCommunityServicePlanEnvelope(conformanceV2Fixture.envelope),
    {
      ...conformanceV2Fixture.envelope,
      plan: normalizeCommunityServicePlan(conformanceV2Fixture.plan)
    }
  );
});

test('schema v2 requires an explicit null or bounded sermon-reading link while v1 stays accepted', () => {
  const normalized = normalizeCommunityServicePlan(planV2());
  assert.deepEqual(normalized.entries[2].sermonReading, {
    sermonEntryId: 'sermon-prayer',
    referenceId: 'primary-eph-3'
  });

  const unlinkedV2 = planV2();
  unlinkedV2.entries[2] = {
    ...unlinkedV2.entries[2],
    range: {
      schemaVersion: 1,
      bookId: 'Gen',
      start: { chapter: 1, verse: 31 },
      end: { chapter: 2, verse: 2 }
    },
    translationId: 'bSb',
    sermonReading: null
  };
  assert.deepEqual(
    normalizeCommunityServicePlan(unlinkedV2).entries[2].sermonReading,
    null
  );

  const legacy = plan();
  legacy.entries[2] = {
    ...legacy.entries[2],
    range: unlinkedV2.entries[2].range,
    translationId: 'bSb'
  };
  assert.equal(normalizeCommunityServicePlan(legacy).schemaVersion, 1);
  assert.equal(
    Object.hasOwn(normalizeCommunityServicePlan(legacy).entries[2], 'sermonReading'),
    false
  );

  const missing = planV2();
  delete missing.entries[2].sermonReading;
  expectCode(
    'INVALID_SERVICE_PLAN_FIELDS',
    () => normalizeCommunityServicePlan(missing)
  );
  const malformed = planV2();
  malformed.entries[2].sermonReading = false;
  expectCode(
    'INVALID_SERVICE_PLAN_SERMON_READING',
    () => normalizeCommunityServicePlan(malformed)
  );
  const unsafeId = planV2();
  unsafeId.entries[2].sermonReading.referenceId = '../private-reference';
  expectCode(
    'INVALID_SERVICE_PLAN_SERMON_READING',
    () => normalizeCommunityServicePlan(unsafeId)
  );
  const v1WithV2Field = plan();
  v1WithV2Field.entries[2].sermonReading = null;
  expectCode(
    'INVALID_SERVICE_PLAN_FIELDS',
    () => normalizeCommunityServicePlan(v1WithV2Field)
  );
});

test('linked v2 readings require one uppercase same-chapter row of at most eight verses', () => {
  const exactlyEight = planV2();
  exactlyEight.entries[2] = {
    ...exactlyEight.entries[2],
    title: 'Psalm 119:1–8',
    range: {
      schemaVersion: 1,
      bookId: 'Ps',
      start: { chapter: 119, verse: 1 },
      end: { chapter: 119, verse: 8 }
    },
    translationId: 'LSV'
  };
  assert.deepEqual(
    normalizeCommunityServicePlan(exactlyEight).entries[2].range,
    exactlyEight.entries[2].range
  );

  const nineVerses = clone(exactlyEight);
  nineVerses.entries[2].range.end.verse = 9;
  expectCode(
    'INVALID_SERVICE_PLAN_SERMON_READING_RANGE',
    () => normalizeCommunityServicePlan(nineVerses)
  );
  const crossChapter = clone(exactlyEight);
  crossChapter.entries[2].range = {
    schemaVersion: 1,
    bookId: 'Gen',
    start: { chapter: 1, verse: 31 },
    end: { chapter: 2, verse: 2 }
  };
  expectCode(
    'INVALID_SERVICE_PLAN_SERMON_READING_RANGE',
    () => normalizeCommunityServicePlan(crossChapter)
  );
  const lowercaseTranslation = clone(exactlyEight);
  lowercaseTranslation.entries[2].translationId = 'bSb';
  expectCode(
    'INVALID_SERVICE_PLAN_SERMON_READING_TRANSLATION',
    () => normalizeCommunityServicePlan(lowercaseTranslation)
  );
});

test('linked v2 readings target one later sermon entry with deterministic relationship failures', () => {
  const missing = planV2();
  missing.entries[2].sermonReading.sermonEntryId = 'missing-sermon';
  expectCode(
    'SERVICE_PLAN_SERMON_READING_TARGET_MISSING',
    () => normalizeCommunityServicePlan(missing)
  );

  const wrongKind = planV2();
  wrongKind.entries[2].sermonReading.sermonEntryId = 'song-grace';
  expectCode(
    'SERVICE_PLAN_SERMON_READING_TARGET_KIND',
    () => normalizeCommunityServicePlan(wrongKind)
  );

  const reversed = planV2();
  const sermon = reversed.entries.pop();
  reversed.entries.splice(2, 0, sermon);
  expectCode(
    'SERVICE_PLAN_SERMON_READING_ORDER',
    () => normalizeCommunityServicePlan(reversed)
  );

  const duplicate = planV2();
  duplicate.entries.splice(3, 0, {
    ...clone(duplicate.entries[2]),
    id: 'second-reading',
    title: 'Ephesians 3:14–16',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 14 },
      end: { chapter: 3, verse: 16 }
    }
  });
  expectCode(
    'DUPLICATE_SERVICE_PLAN_SERMON_READING',
    () => normalizeCommunityServicePlan(duplicate)
  );
});

test('Community service plans serialize as one deterministic canonical source and revision', () => {
  const first = serializeCommunityServicePlan(plan());
  const reordered = serializeCommunityServicePlan({
    entries: plan().entries,
    teamNotes: plan().teamNotes,
    startTime: '10:30',
    serviceDate: '2026-08-02',
    title: plan().title,
    id: plan().id,
    kind: COMMUNITY_SERVICE_PLAN_KIND,
    schemaVersion: 1
  });
  assert.equal(first, reordered);
  assert.equal(first.endsWith('\n'), true);
  const validated = validateCommunityServicePlanSource(first);
  assert.equal(validated.documentSource, first);
  assert.deepEqual(validated.plan, normalizeCommunityServicePlan(plan()));
  assert.equal(
    validated.revision,
    crypto.createHash('sha256').update(first).digest('hex')
  );
  assert.equal(communityServicePlanRevision(plan()), validated.revision);
  assert.equal(communityServicePlanRevision(first), validated.revision);
});

test('canonical source rejects alternate whitespace and non-UTF-8 bytes', () => {
  const canonical = serializeCommunityServicePlan(plan());
  expectCode(
    'NONCANONICAL_SERVICE_PLAN_SOURCE',
    () => parseCommunityServicePlanSource(JSON.stringify(JSON.parse(canonical)))
  );
  assert.deepEqual(
    parseCommunityServicePlanSource(JSON.stringify(JSON.parse(canonical)), {
      requireCanonical: false
    }),
    normalizeCommunityServicePlan(plan())
  );
  expectCode(
    'INVALID_SERVICE_PLAN_UTF8',
    () => parseCommunityServicePlanSource(Buffer.from([0xff, 0xfe]))
  );
});

test('plan, entry, reference, and Bible range shapes reject extra fields', () => {
  expectCode(
    'INVALID_SERVICE_PLAN_FIELDS',
    () => normalizeCommunityServicePlan({ ...plan(), filePath: '/private/sermon.pdf' })
  );
  const credentialPlan = plan();
  credentialPlan.entries[1] = {
    ...credentialPlan.entries[1],
    accessToken: 'must-not-travel'
  };
  expectCode(
    'INVALID_SERVICE_PLAN_FIELDS',
    () => normalizeCommunityServicePlan(credentialPlan)
  );
  const payloadPlan = plan();
  payloadPlan.entries[3] = {
    ...payloadPlan.entries[3],
    documentSource: '{"private":"sermon"}'
  };
  expectCode(
    'INVALID_SERVICE_PLAN_FIELDS',
    () => normalizeCommunityServicePlan(payloadPlan)
  );
  const rangePlan = plan();
  rangePlan.entries[2] = {
    ...rangePlan.entries[2],
    range: {
      ...rangePlan.entries[2].range,
      path: '/tmp/bible.json'
    }
  };
  expectCode(
    'INVALID_SERVICE_PLAN_FIELDS',
    () => normalizeCommunityServicePlan(rangePlan)
  );
});

test('plan records are plain and text is canonical NFC, LF-only, and byte bounded', () => {
  class PlanRecord {}
  Object.assign(new PlanRecord(), plan());
  expectCode(
    'INVALID_SERVICE_PLAN',
    () => normalizeCommunityServicePlan(Object.assign(new PlanRecord(), plan()))
  );

  const normalized = normalizeCommunityServicePlan(plan({
    title: 'Cafe\u0301 Service',
    teamNotes: 'First line\r\nSecond line'
  }));
  assert.equal(normalized.title, 'Café Service');
  assert.equal(normalized.teamNotes, 'First line\nSecond line');

  expectCode(
    'INVALID_SERVICE_PLAN_TEXT',
    () => normalizeCommunityServicePlan(plan({ title: 'é'.repeat(121) }))
  );
  expectCode(
    'INVALID_SERVICE_PLAN_TEXT',
    () => normalizeCommunityServicePlan(plan({ title: 'Unsafe \ud800' }))
  );
  expectCode(
    'INVALID_SERVICE_PLAN_TEXT',
    () => normalizeCommunityServicePlan(plan({ teamNotes: 'No\ttabs' }))
  );
  expectCode(
    'INVALID_SERVICE_PLAN_TEXT',
    () => normalizeCommunityServicePlan(plan({ teamNotes: 'No\u0085C1 controls' }))
  );
  expectCode(
    'INVALID_SERVICE_PLAN_UTF8',
    () => parseCommunityServicePlanSource('{"unsafe":"\ud800"}')
  );
});

test('plans reject invalid dates, local times, duplicate IDs, and unbounded order', () => {
  expectCode(
    'INVALID_SERVICE_PLAN_DATE',
    () => normalizeCommunityServicePlan(plan({ serviceDate: '2026-02-29' }))
  );
  expectCode(
    'INVALID_SERVICE_PLAN_TIME',
    () => normalizeCommunityServicePlan(plan({ startTime: '7:30 PM' }))
  );
  const duplicate = plan();
  duplicate.entries[1] = { ...duplicate.entries[1], id: 'opening' };
  expectCode(
    'DUPLICATE_SERVICE_PLAN_ENTRY',
    () => normalizeCommunityServicePlan(duplicate)
  );
  expectCode(
    'INVALID_SERVICE_PLAN_ENTRIES',
    () => normalizeCommunityServicePlan(plan({
      entries: Array.from(
        { length: MAX_COMMUNITY_SERVICE_PLAN_ITEMS + 1 },
        (_, index) => ({
          id: `section-${index}`,
          kind: 'section',
          title: `Section ${index}`
        })
      )
    }))
  );
});

test('song and sermon references require stable IDs plus exact revision and version', () => {
  for (const [field, value, code] of [
    ['syncId', '../song', 'INVALID_SERVICE_PLAN_TEXT'],
    ['expectedRevision', 'bad revision with spaces', 'INVALID_SERVICE_PLAN_TEXT'],
    ['expectedSyncVersion', 0, 'INVALID_SERVICE_PLAN_VERSION']
  ]) {
    const invalid = plan();
    invalid.entries[1] = { ...invalid.entries[1], [field]: value };
    expectCode(code, () => normalizeCommunityServicePlan(invalid));
  }
  const realSongRevision = plan();
  realSongRevision.entries[1] = {
    ...realSongRevision.entries[1],
    expectedRevision: 'song:family-grace-alone:7'
  };
  assert.equal(
    normalizeCommunityServicePlan(realSongRevision).entries[1].expectedRevision,
    'song:family-grace-alone:7'
  );
  const invalidSermon = plan();
  invalidSermon.entries[3] = {
    ...invalidSermon.entries[3],
    expectedRevision: 'A'.repeat(64)
  };
  expectCode(
    'INVALID_SERVICE_PLAN_REVISION',
    () => normalizeCommunityServicePlan(invalidSermon)
  );
});

test('strict envelopes bind identity, canonical source, revision, version, and timestamp', () => {
  const documentSource = serializeCommunityServicePlan(plan());
  const revision = communityServicePlanRevision(documentSource);
  const envelope = normalizeCommunityServicePlanEnvelope({
    syncId: plan().id,
    syncVersion: 9,
    revision,
    documentSource,
    status: 'ready',
    changedAt: '2026-07-28T20:00:00.000Z'
  });
  assert.equal(envelope.plan.id, plan().id);
  assert.equal(envelope.revision, revision);

  expectCode(
    'SERVICE_PLAN_ID_MISMATCH',
    () => normalizeCommunityServicePlanEnvelope({
      syncId: 'another-plan',
      syncVersion: 9,
      revision,
      documentSource,
      status: 'ready',
      changedAt: '2026-07-28T20:00:00.000Z'
    })
  );
  expectCode(
    'SERVICE_PLAN_REVISION_MISMATCH',
    () => normalizeCommunityServicePlanEnvelope({
      syncId: plan().id,
      syncVersion: 9,
      revision: 'c'.repeat(64),
      documentSource,
      status: 'ready',
      changedAt: '2026-07-28T20:00:00.000Z'
    })
  );
  for (const status of COMMUNITY_SERVICE_PLAN_STATUSES) {
    assert.equal(normalizeCommunityServicePlanEnvelope({
      syncId: plan().id,
      syncVersion: 9,
      revision,
      documentSource,
      status,
      changedAt: '2026-07-28T20:00:00.000Z'
    }).status, status);
  }
  expectCode(
    'INVALID_SERVICE_PLAN_STATUS',
    () => normalizeCommunityServicePlanEnvelope({
      syncId: plan().id,
      syncVersion: 9,
      revision,
      documentSource,
      status: 'published',
      changedAt: '2026-07-28T20:00:00.000Z'
    })
  );
});

test('strict plan pages reject duplicates and inconsistent cursor state', () => {
  const summary = {
    syncId: plan().id,
    syncVersion: 9,
    revision: communityServicePlanRevision(plan()),
    status: 'archived',
    title: plan().title,
    serviceDate: plan().serviceDate,
    startTime: plan().startTime,
    changedAt: '2026-07-28T20:00:00.000Z'
  };
  assert.deepEqual(normalizeCommunityServicePlanPage({
    items: [summary],
    nextCursor: 'signed-cursor',
    hasMore: true
  }), {
    items: [summary],
    nextCursor: 'signed-cursor',
    hasMore: true
  });
  expectCode(
    'INVALID_SERVICE_PLAN_PAGE',
    () => normalizeCommunityServicePlanPage({
      items: [summary, summary],
      nextCursor: null,
      hasMore: false
    })
  );
  expectCode(
    'INVALID_SERVICE_PLAN_PAGE',
    () => normalizeCommunityServicePlanPage({
      items: [],
      nextCursor: null,
      hasMore: true
    })
  );
});
