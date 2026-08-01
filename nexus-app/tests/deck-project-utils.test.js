import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLogicalRegionChains,
  logicalRegionChainIds,
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

test('rejects exact-start and backward placement without edit actions', () => {
  const regions = [
    region('old', 0, 100),
    region('latest', 200, 100, {
      sampleId: 'sample-b',
      automationCollectionId: 'automation-b',
    }),
  ]
  assert.deepEqual(planForwardTimelineInsertion(regions, 200), {
    kind: 'reject',
    reason: 'region-starts-at-boundary',
  })
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

test('scopes unload to the controlled logical chain', () => {
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
