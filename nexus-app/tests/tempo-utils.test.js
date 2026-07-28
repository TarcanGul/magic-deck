import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampTempoPercent,
  effectiveBpm,
  mappedDurationTicks,
  reconstructTempoPercent,
  smallestTempoRange,
  tempoPercentForBpm,
  tempoPercentToPlaybackRate,
} from '../src/tempo-utils.js'

test('converts tempo percentage to playback rate and effective BPM', () => {
  assert.equal(tempoPercentToPlaybackRate(10), 1.1)
  assert.equal(tempoPercentToPlaybackRate(-10), 0.9)
  assert.equal(effectiveBpm(120, 10), 132)
  assert.equal(effectiveBpm(120, -10), 108)
  assert.ok(Math.abs(tempoPercentForBpm(128, 120) + 6.25) < 1e-9)
})

test('calculates mapped tick durations at faster and slower tempos', () => {
  assert.equal(mappedDurationTicks(3840, 0), 3840)
  assert.equal(mappedDurationTicks(3840, 20), 3200)
  assert.equal(mappedDurationTicks(3840, -20), 4800)
})

test('clamps values when a narrower range is selected', () => {
  assert.equal(clampTempoPercent(24, 10), 10)
  assert.equal(clampTempoPercent(-24, 10), -10)
  assert.equal(clampTempoPercent(7.5, 10), 7.5)
})

test('selects the smallest range that can reach a sync target', () => {
  assert.equal(smallestTempoRange(8), 10)
  assert.equal(smallestTempoRange(-24), 30)
  assert.equal(smallestTempoRange(49.5), 50)
})

test('rejects sync targets beyond the fifty percent range', () => {
  assert.equal(smallestTempoRange(50.001), null)
  assert.equal(smallestTempoRange(-51), null)
})

test('reconstructs tempo percentage from synchronized region timing', () => {
  const nativeTicks = 7680
  for (const percent of [-50, -10, 0, 12.5, 50]) {
    const mappedTicks = mappedDurationTicks(nativeTicks, percent)
    assert.ok(Math.abs(reconstructTempoPercent(nativeTicks, mappedTicks) - percent) < 0.02)
  }
})
