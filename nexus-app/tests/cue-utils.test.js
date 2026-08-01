import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIndependentAudioRegionCopy,
  cueBarForPosition,
  cuePositionForBar,
  cuePositionsFromSegments,
  planAudioRegionSplit,
  planLegacyCueChainCollapse,
  planResizedCueOffsets,
} from '../src/cue-utils.js'

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
