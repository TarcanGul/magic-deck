import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndependentAudioRegionCopy,
  cueBarForPosition,
  cuePositionForBar,
  cuePositionsFromSegments,
  planAudioRegionSplit,
  planLegacyCueChainCollapse,
  planMagicCueLoopLaunch,
  planCueRegionDuplicate,
  planResizedCueOffsets,
  planSourceInstanceTimingResize,
} from '../src/cue-utils.js'

test('plans a loop-preserving Magic cue launch for the normal scheduled span', () => {
  const source = {
    region: {
      positionTicks: 1_000,
      durationTicks: 64_000,
      collectionOffsetTicks: 0,
      loopOffsetTicks: 100,
      loopDurationTicks: 16_000,
      isEnabled: false,
      colorIndex: 4,
      displayName: 'MAGIC DECK — prompt',
    },
    track: 'magic-track',
    playbackAutomationCollection: 'magic-automation',
    sample: 'magic-sample',
    gain: 0.75,
    fadeInDurationTicks: 500,
    fadeInSlope: 0.25,
    fadeOutDurationTicks: 750,
    fadeOutSlope: 0.8,
    timestretchMode: 2,
    pitchShiftSemitones: -2,
  }
  const immutableSnapshot = structuredClone(source)
  const plan = planMagicCueLoopLaunch({
    source,
    targetPositionTicks: 96_000,
    loopDurationTicks: 16_000,
    scheduledDurationTicks: 80_000,
    cuePosition: 0.375,
  })

  assert.equal(plan.cueOffsetTicks, 6_000)
  assert.equal(plan.firstLoopDurationTicks, 10_000)
  assert.equal(plan.scheduledDurationTicks, 80_000)
  assert.deepEqual(plan.region.region, {
    ...source.region,
    positionTicks: 96_000,
    durationTicks: 80_000,
    collectionOffsetTicks: 6_100,
    loopDurationTicks: 16_000,
    isEnabled: true,
  })
  assert.equal(plan.region.track, 'magic-track')
  assert.equal(plan.region.playbackAutomationCollection, 'magic-automation')
  assert.equal(plan.region.sample, 'magic-sample')
  assert.equal(plan.region.gain, 0.75)
  assert.equal(plan.region.timestretchMode, 2)
  assert.equal(plan.region.pitchShiftSemitones, -2)
  assert.deepEqual(source, immutableSnapshot)
})

test('validates Magic cue loop launch boundaries', () => {
  const source = {
    region: {
      positionTicks: 0,
      durationTicks: 16_000,
      collectionOffsetTicks: 0,
      loopOffsetTicks: 0,
      loopDurationTicks: 16_000,
      isEnabled: true,
      colorIndex: 1,
      displayName: 'Magic',
    },
    track: 'track',
    playbackAutomationCollection: 'automation',
    sample: 'sample',
    gain: 1,
    fadeInDurationTicks: 0,
    fadeInSlope: 0,
    fadeOutDurationTicks: 0,
    fadeOutSlope: 0,
    timestretchMode: 2,
    pitchShiftSemitones: 0,
  }
  const plan = (overrides = {}) => planMagicCueLoopLaunch({
    source,
    targetPositionTicks: 0,
    loopDurationTicks: 16_000,
    scheduledDurationTicks: 64_000,
    cuePosition: 0,
    ...overrides,
  })

  assert.equal(plan().firstLoopDurationTicks, 16_000)
  assert.throws(() => plan({ targetPositionTicks: -1 }), /target/)
  assert.throws(() => plan({ loopDurationTicks: 0 }), /loop duration/)
  assert.throws(() => plan({ scheduledDurationTicks: 0 }), /scheduled duration/)
  assert.throws(() => plan({ cuePosition: 1 }), /\[0, 1\)/)
  assert.throws(() => plan({ cuePosition: 0.999_99 }), /playable audio/)
})

test('plans adjacent audio regions without changing playback alignment', () => {
  const original = {
    positionTicks: 1_000,
    durationTicks: 8_000,
    collectionOffsetTicks: 240,
    loopOffsetTicks: 120,
    loopDurationTicks: 3_840,
  }
  const split = planAudioRegionSplit(original, 4_000)

  assert.equal(split.leftDurationTicks, 3_000)
  assert.deepEqual(split.right, {
    positionTicks: 4_000,
    durationTicks: 5_000,
    collectionOffsetTicks: 3_240,
    loopOffsetTicks: 120,
    loopDurationTicks: 3_840,
  })
  assert.equal(
    original.positionTicks + original.loopOffsetTicks - original.collectionOffsetTicks,
    split.right.positionTicks + split.right.loopOffsetTicks
      - split.right.collectionOffsetTicks,
  )
})

test('rejects cuts at or outside region edges', () => {
  const region = {
    positionTicks: 100,
    durationTicks: 500,
    collectionOffsetTicks: 0,
    loopOffsetTicks: 0,
    loopDurationTicks: 500,
  }
  for (const cutTicks of [99, 100, 600, 601, 100.5]) {
    assert.throws(() => planAudioRegionSplit(region, cutTicks), /strictly inside/)
  }
})

test('creates split regions with independent owned fields and only shared Nexus references', () => {
  const track = { entityId: 'track' }
  const playbackAutomationCollection = { entityId: 'automation' }
  const sample = { entityId: 'sample' }
  const original = {
    region: {
      positionTicks: 1_000,
      durationTicks: 8_000,
      collectionOffsetTicks: 240,
      loopOffsetTicks: 120,
      loopDurationTicks: 3_840,
      isEnabled: true,
      colorIndex: 12,
      displayName: 'Deck sample',
    },
    track,
    playbackAutomationCollection,
    sample,
    gain: 0.75,
    fadeInDurationTicks: 40,
    fadeInSlope: -0.25,
    fadeOutDurationTicks: 80,
    fadeOutSlope: 0.5,
    timestretchMode: 2,
    pitchShiftSemitones: -3,
  }
  const split = planAudioRegionSplit(original.region, 4_000)
  const right = buildIndependentAudioRegionCopy(original, {
    region: split.right,
    fadeInDurationTicks: 0,
  })

  assert.notStrictEqual(right.region, original.region)
  assert.deepEqual(Object.keys(right.region).sort(), [
    'collectionOffsetTicks',
    'colorIndex',
    'displayName',
    'durationTicks',
    'isEnabled',
    'loopDurationTicks',
    'loopOffsetTicks',
    'positionTicks',
  ])
  assert.deepEqual(Object.keys(right).sort(), [
    'fadeInDurationTicks',
    'fadeInSlope',
    'fadeOutDurationTicks',
    'fadeOutSlope',
    'gain',
    'pitchShiftSemitones',
    'playbackAutomationCollection',
    'region',
    'sample',
    'timestretchMode',
    'track',
  ])
  assert.strictEqual(right.track, track)
  assert.strictEqual(right.playbackAutomationCollection, playbackAutomationCollection)
  assert.strictEqual(right.sample, sample)
  assert.deepEqual(right.region, {
    ...original.region,
    ...split.right,
  })
  assert.equal(right.gain, original.gain)
  assert.equal(right.fadeInDurationTicks, 0)
  assert.equal(right.fadeInSlope, original.fadeInSlope)
  assert.equal(right.fadeOutDurationTicks, original.fadeOutDurationTicks)
  assert.equal(right.fadeOutSlope, original.fadeOutSlope)
  assert.equal(right.timestretchMode, original.timestretchMode)
  assert.equal(right.pitchShiftSemitones, original.pitchShiftSemitones)
})

test('plans an exact-position cropped duplicate with independent playback automation', () => {
  const sourceAutomation = { entityId: 'automation-original' }
  const duplicateAutomation = { entityId: 'automation-duplicate' }
  const source = {
    region: {
      positionTicks: 3_840,
      durationTicks: 10_001,
      collectionOffsetTicks: 0,
      loopOffsetTicks: 120,
      loopDurationTicks: 6_000,
      isEnabled: true,
      colorIndex: 7,
      displayName: 'Deck A source',
    },
    track: { entityId: 'track' },
    playbackAutomationCollection: sourceAutomation,
    sample: { entityId: 'sample' },
    gain: 0.8,
    fadeInDurationTicks: 900,
    fadeInSlope: -0.25,
    fadeOutDurationTicks: 2_000,
    fadeOutSlope: 0.5,
    timestretchMode: 2,
    pitchShiftSemitones: -2,
  }
  const original = structuredClone(source)
  const plan = planCueRegionDuplicate({
    source,
    playbackAutomationCollection: duplicateAutomation,
    targetPositionTicks: 49_920,
    fullDurationTicks: 10_001,
    cuePosition: 0.75,
  })

  assert.deepEqual(source, original)
  assert.equal(plan.cueOffsetTicks, 7_501)
  assert.equal(plan.remainingDurationTicks, 2_500)
  assert.equal(plan.automationTerminalTicks, 10_001)
  assert.strictEqual(plan.region.playbackAutomationCollection, duplicateAutomation)
  assert.notStrictEqual(plan.region.playbackAutomationCollection, sourceAutomation)
  assert.deepEqual(plan.region.region, {
    ...source.region,
    positionTicks: 49_920,
    durationTicks: 2_500,
    collectionOffsetTicks: 7_501,
    loopDurationTicks: 6_000,
  })
  assert.equal(plan.region.fadeInDurationTicks, 900)
  assert.equal(plan.region.fadeOutDurationTicks, 1_600)
})

test('rejects invalid duplicate scheduling without mutating the source payload', () => {
  const source = {
    region: {
      positionTicks: 0,
      durationTicks: 1_000,
      collectionOffsetTicks: 0,
      loopOffsetTicks: 0,
      loopDurationTicks: 1_000,
      isEnabled: true,
      colorIndex: 1,
      displayName: 'Deck source',
    },
    track: 'track',
    playbackAutomationCollection: 'original-automation',
    sample: 'sample',
    gain: 1,
    fadeInDurationTicks: 0,
    fadeInSlope: 0,
    fadeOutDurationTicks: 0,
    fadeOutSlope: 0,
    timestretchMode: 2,
    pitchShiftSemitones: 0,
  }
  const original = structuredClone(source)
  assert.throws(() => planCueRegionDuplicate({
    source,
    playbackAutomationCollection: 'duplicate-automation',
    targetPositionTicks: -1,
    fullDurationTicks: 1_000,
    cuePosition: 0.5,
  }), /non-negative/)
  assert.throws(() => planCueRegionDuplicate({
    source,
    playbackAutomationCollection: 'duplicate-automation',
    targetPositionTicks: 0,
    fullDurationTicks: 1_000,
    cuePosition: 1,
  }), /\[0, 1\)/)
  assert.deepEqual(source, original)
})

test('resizes natural and explicitly stopped instances without moving their timeline starts', () => {
  const natural = planSourceInstanceTimingResize({
    positionTicks: 40_000,
    durationTicks: 7_500,
    collectionOffsetTicks: 2_500,
    loopOffsetTicks: 100,
    loopDurationTicks: 10_000,
    previousFullDurationTicks: 10_000,
    nextFullDurationTicks: 12_000,
  })
  assert.deepEqual(natural, {
    positionTicks: 40_000,
    durationTicks: 9_000,
    collectionOffsetTicks: 3_000,
    loopOffsetTicks: 120,
    loopDurationTicks: 12_000,
    automationTerminalTicks: 12_000,
    explicitlyShortened: false,
  })

  const stopped = planSourceInstanceTimingResize({
    positionTicks: 80_000,
    durationTicks: 2_000,
    collectionOffsetTicks: 2_500,
    loopOffsetTicks: 100,
    loopDurationTicks: 10_000,
    previousFullDurationTicks: 10_000,
    nextFullDurationTicks: 4_000,
  })
  assert.equal(stopped.positionTicks, 80_000)
  assert.equal(stopped.collectionOffsetTicks, 1_000)
  assert.equal(stopped.durationTicks, 2_000)
  assert.equal(stopped.explicitlyShortened, true)

  const clamped = planSourceInstanceTimingResize({
    positionTicks: 80_000,
    durationTicks: 4_000,
    collectionOffsetTicks: 5_000,
    loopOffsetTicks: 0,
    loopDurationTicks: 10_000,
    previousFullDurationTicks: 10_000,
    nextFullDurationTicks: 6_000,
  })
  assert.equal(clamped.durationTicks, 3_000)
})

test('derives authoritative cue positions from contiguous project segments', () => {
  assert.deepEqual(cuePositionsFromSegments([
    { id: 'right', positionTicks: 7_000, durationTicks: 3_000 },
    { id: 'left', positionTicks: 2_000, durationTicks: 2_000 },
    { id: 'middle', positionTicks: 4_000, durationTicks: 3_000 },
  ]), [0.25, 0.625])
})

test('does not infer cues from project regions with gaps', () => {
  assert.deepEqual(cuePositionsFromSegments([
    { id: 'left', positionTicks: 0, durationTicks: 2_000 },
    { id: 'right', positionTicks: 2_001, durationTicks: 1_999 },
  ]), [])
})

test('keeps cue-cut source alignment when region and loop durations scale differently', () => {
  const left = planResizedCueOffsets({
    firstCollectionOffsetTicks: 120,
    firstLoopOffsetTicks: 40,
    loopDurationTicks: 4_000,
    previousContentDurationTicks: 4_000,
    nextContentDurationTicks: 5_000,
    nextStartTicks: 0,
  })
  const right = planResizedCueOffsets({
    firstCollectionOffsetTicks: 120,
    firstLoopOffsetTicks: 40,
    loopDurationTicks: 4_000,
    previousContentDurationTicks: 4_000,
    nextContentDurationTicks: 5_000,
    nextStartTicks: 3_000,
  })

  assert.equal(right.collectionOffsetTicks, left.collectionOffsetTicks + 3_000)
  assert.equal(right.loopOffsetTicks, left.loopOffsetTicks)
  assert.equal(right.loopDurationTicks, left.loopDurationTicks)
  assert.equal(
    left.loopOffsetTicks - left.collectionOffsetTicks,
    3_000 + right.loopOffsetTicks - right.collectionOffsetTicks,
  )
})

test('converts track-relative bars to normalized cue positions', () => {
  assert.equal(cuePositionForBar(1, 1_000, 4_500), 0)
  assert.equal(cuePositionForBar(3, 1_000, 4_500), 2_000 / 4_500)
  assert.equal(cueBarForPosition(2_000 / 4_500, 1_000, 4_500), 3)
  assert.throws(() => cuePositionForBar(5, 1_000, 4_000), /strictly before/)
  assert.throws(() => cuePositionForBar(1.5, 1_000, 4_000), /whole number/)
  assert.throws(() => cueBarForPosition(1, 1_000, 4_000), /\[0, 1\)/)
})

test('preserves exact normalized cue positions across duration changes', () => {
  const position = cuePositionForBar(3, 1_000, 7_001)
  assert.equal(Math.round(position * 7_001), 2_000)
  assert.equal(Math.round(position * 9_503), 2_715)
  assert.equal(position, 2_000 / 7_001)
})

test('schedules a non-bar-aligned source cue without requantizing it', () => {
  const fullDurationTicks = 96_001
  const cueOffsetTicks = 19_323
  const plan = planCueRegionDuplicate({
    source: {
      region: {
        positionTicks: 0, durationTicks: fullDurationTicks,
        collectionOffsetTicks: 0, loopOffsetTicks: 0,
        loopDurationTicks: fullDurationTicks, isEnabled: true,
        colorIndex: 2, displayName: 'Precise source cue',
      },
      track: 'track', playbackAutomationCollection: 'source-automation', sample: 'sample',
      gain: 1, fadeInDurationTicks: 0, fadeInSlope: 0,
      fadeOutDurationTicks: 0, fadeOutSlope: 0,
      timestretchMode: 2, pitchShiftSemitones: 0,
    },
    playbackAutomationCollection: 'cue-automation',
    targetPositionTicks: 153_600,
    fullDurationTicks,
    cuePosition: cueOffsetTicks / fullDurationTicks,
  })

  assert.equal(plan.cueOffsetTicks, cueOffsetTicks)
  assert.equal(plan.region.region.collectionOffsetTicks, cueOffsetTicks)
  assert.equal(plan.region.region.positionTicks, 153_600)
  assert.equal(plan.region.region.durationTicks, fullDurationTicks - cueOffsetTicks)
})

test('plans legacy cue chain collapse from the earliest aligned region', () => {
  const result = planLegacyCueChainCollapse([
    {
      id: 'tail', positionTicks: 4_000, durationTicks: 2_000,
      collectionOffsetTicks: 3_120, loopOffsetTicks: 80,
      fadeOutDurationTicks: 240, fadeOutSlope: 0.5,
    },
    {
      id: 'head', positionTicks: 1_000, durationTicks: 3_000,
      collectionOffsetTicks: 120, loopOffsetTicks: 80,
      displayName: 'Deck A', gain: 0.75, pitchShiftSemitones: -2,
      fadeOutDurationTicks: 0, fadeOutSlope: 0,
    },
  ])
  assert.equal(result.keepId, 'head')
  assert.equal(result.durationTicks, 5_000)
  assert.deepEqual(result.removeIds, ['tail'])
  assert.equal(result.collapsedRegion.collectionOffsetTicks, 120)
  assert.equal(result.collapsedRegion.loopOffsetTicks, 80)
  assert.equal(result.collapsedRegion.displayName, 'Deck A')
  assert.equal(result.collapsedRegion.gain, 0.75)
  assert.equal(result.collapsedRegion.pitchShiftSemitones, -2)
  assert.equal(result.collapsedRegion.fadeOutDurationTicks, 240)
  assert.equal(result.collapsedRegion.fadeOutSlope, 0.5)
})
