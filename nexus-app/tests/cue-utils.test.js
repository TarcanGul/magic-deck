import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cuePositionsFromSegments,
  planAudioRegionSplit,
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
