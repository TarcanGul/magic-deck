import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLogicalRegionChains,
  logicalRegionChainIds,
  planDeckTrackClear,
  planForwardTimelineInsertion,
  planNonOverlappingCueTakeover,
  selectCanonicalRouting,
  selectLatestLogicalRegion,
} from '../src/deck-project-utils.js'

function region(id, positionTicks, durationTicks, overrides = {}) {
  return {
    id,
    sampleId: 'sample-a',
    automationCollectionId: 'automation-a',
    positionTicks,
    durationTicks,
    fadeInDurationTicks: 10,
    fadeOutDurationTicks: 10,
    ...overrides,
  }
}

test('selects exact canonical routing before deterministic legacy graphs', () => {
  const legacyFirst = {
    trackId: 'track-a',
    trackOrder: 0,
    deviceName: 'DECK 1 — old.wav',
    stripName: 'DECK 1',
  }
  const exactLater = {
    trackId: 'track-z',
    trackOrder: 10,
    deviceName: 'DECK 1',
    stripName: 'DECK 1',
  }
  assert.equal(
    selectCanonicalRouting([legacyFirst, exactLater], 'DECK 1'),
    exactLater,
  )
})

test('selects one deterministic legacy graph and ignores unrelated duplicates', () => {
  const candidates = [
    {
      trackId: 'track-z',
      trackOrder: 4,
      deviceName: 'DECK 2 — later.wav',
      stripName: 'DECK 2',
    },
    {
      trackId: 'track-b',
      trackOrder: 2,
      deviceName: 'DECK 2 — earlier.wav',
      stripName: 'DECK 2',
    },
    {
      trackId: 'track-a',
      trackOrder: 2,
      deviceName: 'DECK 2 — tie.wav',
      stripName: 'DECK 2',
    },
    {
      trackId: 'track-other',
      trackOrder: 0,
      deviceName: 'OTHER',
      stripName: 'OTHER',
    },
  ]
  assert.equal(
    selectCanonicalRouting(candidates, 'DECK 2')?.trackId,
    'track-a',
  )
  assert.equal(selectCanonicalRouting([candidates[3]], 'DECK 2'), null)
})

test('plans insertion without touching non-crossing history', () => {
  const regions = [
    region('history', 0, 100),
    region('latest', 200, 50),
  ]
  assert.deepEqual(planForwardTimelineInsertion(regions, 300), {
    kind: 'insert',
    truncate: [],
    removeRegionIds: [],
  })
})

test('leaves a region ending exactly at the boundary unchanged', () => {
  assert.deepEqual(planForwardTimelineInsertion([region('old', 0, 100)], 100), {
    kind: 'insert',
    truncate: [],
    removeRegionIds: [],
  })
})

test('truncates only a region that strictly crosses the insertion boundary', () => {
  const result = planForwardTimelineInsertion([
    region('history', 0, 40),
    region('crossing', 100, 100),
  ], 160)
  assert.deepEqual(result, {
    kind: 'insert',
    truncate: [{
      id: 'crossing',
      durationTicks: 60,
      fadeInDurationTicks: 10,
      fadeOutDurationTicks: 10,
    }],
    removeRegionIds: [],
  })
})

test('retains a cue-cut chain prefix and removes only its future tail', () => {
  const regions = [
    region('part-a', 100, 50),
    region('part-b', 150, 50),
    region('part-c', 200, 50),
    region('unrelated-history', 0, 25, {
      sampleId: 'sample-history',
      automationCollectionId: 'automation-history',
    }),
  ]
  assert.deepEqual(buildLogicalRegionChains(regions).map((chain) => chain.map(({ id }) => id)), [
    ['part-a', 'part-b', 'part-c'],
    ['unrelated-history'],
  ])
  assert.deepEqual(planForwardTimelineInsertion(regions, 175), {
    kind: 'insert',
    truncate: [{
      id: 'part-b',
      durationTicks: 25,
      fadeInDurationTicks: 10,
      fadeOutDurationTicks: 10,
    }],
    removeRegionIds: ['part-c'],
  })
})

test('clamps fades after a short truncation without changing playback offsets', () => {
  const crossing = region('crossing', 100, 100, {
    fadeInDurationTicks: 18,
    fadeOutDurationTicks: 25,
    collectionOffsetTicks: 80,
    loopOffsetTicks: 5,
  })
  const result = planForwardTimelineInsertion([crossing], 120)
  assert.deepEqual(result, {
    kind: 'insert',
    truncate: [{
      id: 'crossing',
      durationTicks: 20,
      fadeInDurationTicks: 18,
      fadeOutDurationTicks: 2,
    }],
    removeRegionIds: [],
  })
  assert.equal(crossing.collectionOffsetTicks, 80)
  assert.equal(crossing.loopOffsetTicks, 5)
})

test('overwrites exact-start content from the selected boundary forward', () => {
  const regions = [
    region('old', 0, 100),
    region('latest', 200, 100, {
      sampleId: 'sample-b',
      automationCollectionId: 'automation-b',
    }),
    region('latest-tail', 300, 100, {
      sampleId: 'sample-b',
      automationCollectionId: 'automation-b',
    }),
    region('later-insertion', 500, 100, {
      sampleId: 'sample-c',
      automationCollectionId: 'automation-c',
    }),
  ]
  assert.deepEqual(planForwardTimelineInsertion(regions, 200), {
    kind: 'insert',
    truncate: [],
    removeRegionIds: ['later-insertion', 'latest', 'latest-tail'],
  })
})

test('rejects backward placement when no content starts at the selected boundary', () => {
  const regions = [
    region('old', 0, 100),
    region('latest', 200, 100, {
      sampleId: 'sample-b',
      automationCollectionId: 'automation-b',
    }),
  ]
  assert.deepEqual(planForwardTimelineInsertion(regions, 150), {
    kind: 'reject',
    reason: 'backward-placement',
  })
})

test('restores the newest logical insertion with an entity-id tie-breaker', () => {
  const regions = [
    region('chain-head', 100, 50),
    region('chain-tail', 150, 50),
    region('newer-a', 300, 50, {
      sampleId: 'sample-b',
      automationCollectionId: 'automation-b',
    }),
    region('newer-z', 300, 50, {
      sampleId: 'sample-c',
      automationCollectionId: 'automation-c',
    }),
  ]
  assert.equal(selectLatestLogicalRegion(regions)?.id, 'newer-z')
})

test('scopes a logical region lookup to the controlled chain', () => {
  const regions = [
    region('part-a', 100, 50),
    region('part-b', 150, 50),
    region('history', 0, 25, {
      sampleId: 'sample-history',
      automationCollectionId: 'automation-history',
    }),
  ]
  assert.deepEqual(logicalRegionChainIds(regions, 'part-b'), ['part-a', 'part-b'])
  assert.deepEqual(logicalRegionChainIds(regions, 'missing'), [])
})

test('plans clearing every audio region on one deck track', () => {
  const regions = [
    { id: 'chunk-a1', trackId: 'deck-a', sampleId: 'sample-a1', automationCollectionId: 'automation-a1' },
    { id: 'chunk-a2', trackId: 'deck-a', sampleId: 'sample-a2', automationCollectionId: 'automation-a2' },
    { id: 'cue-derived', trackId: 'deck-a', sampleId: 'sample-a1', automationCollectionId: 'automation-cue' },
    { id: 'older-group', trackId: 'deck-a', sampleId: 'sample-old', automationCollectionId: 'automation-old' },
    { id: 'manual-region', trackId: 'deck-a', sampleId: 'sample-manual', automationCollectionId: 'automation-manual' },
    { id: 'deck-b-region', trackId: 'deck-b', sampleId: 'sample-b', automationCollectionId: 'automation-b' },
  ]

  assert.deepEqual(planDeckTrackClear(regions, 'deck-a'), {
    regionIds: ['chunk-a1', 'chunk-a2', 'cue-derived', 'manual-region', 'older-group'],
    sampleIds: ['sample-a1', 'sample-a2', 'sample-manual', 'sample-old'],
    automationCollectionIds: [
      'automation-a1',
      'automation-a2',
      'automation-cue',
      'automation-manual',
      'automation-old',
    ],
  })
})

test('preserves dependencies referenced by regions outside the cleared track', () => {
  const regions = [
    { id: 'deck-a-shared', trackId: 'deck-a', sampleId: 'sample-shared', automationCollectionId: 'automation-shared' },
    { id: 'deck-a-only', trackId: 'deck-a', sampleId: 'sample-only', automationCollectionId: 'automation-only' },
    { id: 'deck-b-shared', trackId: 'deck-b', sampleId: 'sample-shared', automationCollectionId: 'automation-shared' },
    { id: 'deck-b-catalog', trackId: 'deck-b', sampleId: 'catalog-shared', automationCollectionId: 'catalog-shared-automation' },
  ]

  assert.deepEqual(planDeckTrackClear(regions, 'deck-a', [
    { sampleId: 'catalog-only', automationCollectionId: 'catalog-automation' },
    { sampleId: 'catalog-shared', automationCollectionId: 'catalog-shared-automation' },
    { sampleId: 'sample-shared', automationCollectionId: 'automation-shared' },
  ]), {
    regionIds: ['deck-a-only', 'deck-a-shared'],
    sampleIds: ['catalog-only', 'sample-only'],
    automationCollectionIds: ['automation-only', 'catalog-automation'],
  })
})

test('clear plans contain content only and never routing entities', () => {
  const plan = planDeckTrackClear([
    { id: 'region-a', trackId: 'track-a', sampleId: 'sample-a', automationCollectionId: 'automation-a' },
  ], 'track-a')

  assert.deepEqual(Object.keys(plan).sort(), [
    'automationCollectionIds',
    'regionIds',
    'sampleIds',
  ])
  assert.equal(JSON.stringify(plan).includes('track-a'), false)
  assert.equal(JSON.stringify(plan).includes('device-a'), false)
  assert.equal(JSON.stringify(plan).includes('cable-a'), false)
})

test('clears all Magic generations while retaining shared dependencies and routing', () => {
  const plan = planDeckTrackClear([
    { id: 'magic-current', trackId: 'magic-track', sampleId: 'magic-current-sample', automationCollectionId: 'magic-current-automation' },
    { id: 'magic-cue', trackId: 'magic-track', sampleId: 'magic-current-sample', automationCollectionId: 'magic-current-automation' },
    { id: 'magic-history', trackId: 'magic-track', sampleId: 'shared-sample', automationCollectionId: 'shared-automation' },
    { id: 'deck-a-shared', trackId: 'deck-a', sampleId: 'shared-sample', automationCollectionId: 'shared-automation' },
  ], 'magic-track')

  assert.deepEqual(plan, {
    regionIds: ['magic-cue', 'magic-current', 'magic-history'],
    sampleIds: ['magic-current-sample'],
    automationCollectionIds: ['magic-current-automation'],
  })
  assert.equal('trackIds' in plan, false)
  assert.equal('routingIds' in plan, false)
})

test('lets a scheduled cue take over its bar without overlapping existing deck regions', () => {
  const regions = [
    region('original', 0, 100),
    region('first-cue', 40, 60, {
      automationCollectionId: 'automation-first-cue',
    }),
    region('later', 120, 30, {
      automationCollectionId: 'automation-later',
    }),
  ]
  assert.deepEqual(planNonOverlappingCueTakeover(regions, 70, 40), {
    truncate: [
      {
        id: 'original',
        durationTicks: 40,
        fadeInDurationTicks: 10,
        fadeOutDurationTicks: 10,
      },
      {
        id: 'first-cue',
        durationTicks: 30,
        fadeInDurationTicks: 10,
        fadeOutDurationTicks: 10,
      },
    ],
    removeRegionIds: [],
  })
})

test('removes displaced starts inside the new cue span and preserves later regions', () => {
  const regions = [
    region('crossing', 0, 100),
    region('same-start', 50, 100, {
      automationCollectionId: 'automation-same',
    }),
    region('inside', 75, 10, {
      automationCollectionId: 'automation-inside',
    }),
    region('after', 100, 20, {
      automationCollectionId: 'automation-after',
    }),
  ]
  assert.deepEqual(planNonOverlappingCueTakeover(regions, 50, 50), {
    truncate: [{
      id: 'crossing',
      durationTicks: 50,
      fadeInDurationTicks: 10,
      fadeOutDurationTicks: 10,
    }],
    removeRegionIds: ['inside', 'same-start'],
  })
})
