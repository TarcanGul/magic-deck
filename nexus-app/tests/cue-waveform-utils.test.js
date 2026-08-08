import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampCueTicks,
  createCueViewport,
  cuePositionFromPointer,
  cueTicksToNormalizedPosition,
  formatCueTickPosition,
  normalizedCuePositionToTicks,
  panCueViewport,
  zoomCueViewport,
} from '../src/cue-waveform-utils.js'

test('zooms around an anchor and clamps the viewport at track boundaries', () => {
  const centered = zoomCueViewport(createCueViewport(), 4, 0.6, 0.25)
  assert.deepEqual(centered, { zoomLevel: 4, start: 0.5375, end: 0.7875 })
  assert.deepEqual(
    zoomCueViewport(createCueViewport(), 8, 0.01, 0.5),
    { zoomLevel: 8, start: 0, end: 0.125 },
  )
  assert.deepEqual(
    zoomCueViewport(createCueViewport(), 8, 0.99, 0.5),
    { zoomLevel: 8, start: 0.875, end: 1 },
  )
})

test('maps pointers through the visible viewport', () => {
  const viewport = { zoomLevel: 4, start: 0.25, end: 0.5 }
  assert.equal(cuePositionFromPointer(0, 800, viewport), 0.25)
  assert.equal(cuePositionFromPointer(400, 800, viewport), 0.375)
  assert.equal(cuePositionFromPointer(800, 800, viewport), 0.5)
})

test('pans while preserving span and clamps both boundaries', () => {
  const viewport = { zoomLevel: 4, start: 0.25, end: 0.5 }
  assert.deepEqual(panCueViewport(viewport, 0.1), {
    zoomLevel: 4, start: 0.35, end: 0.6,
  })
  assert.deepEqual(panCueViewport(viewport, -1), {
    zoomLevel: 4, start: 0, end: 0.25,
  })
  assert.deepEqual(panCueViewport(viewport, 1), {
    zoomLevel: 4, start: 0.75, end: 1,
  })
})

test('round-trips exact cue ticks and clamps the end of the track', () => {
  const durationTicks = 96_001
  const normalized = cueTicksToNormalizedPosition(12_345, durationTicks)
  assert.equal(normalizedCuePositionToTicks(normalized, durationTicks), 12_345)
  assert.equal(normalizedCuePositionToTicks(1, durationTicks), 96_000)
  assert.equal(clampCueTicks(-20, durationTicks), 0)
  assert.equal(clampCueTicks(200_000, durationTicks), 96_000)
})

test('formats bar, beat, tick, and millisecond source position', () => {
  assert.equal(
    formatCueTickPosition(19_323, 61_440, 15_360, 3_840, 32),
    'B2.2.123 · 0:10.064',
  )
  assert.equal(
    formatCueTickPosition(99_999, 61_440, 15_360, 3_840, 32),
    'B4.4.3839 · 0:31.999',
  )
})

test('keeps Magic loop navigation tick-precise through zoom, pan, and reset', () => {
  const loopDurationTicks = 61_440
  const cueTicks = 19_323
  const cuePosition = cueTicksToNormalizedPosition(cueTicks, loopDurationTicks)
  const zoomed = zoomCueViewport(createCueViewport(), 8, cuePosition, 0.5)
  const panned = panCueViewport(zoomed, 0.01)
  const pointerPosition = cuePositionFromPointer(600, 1200, panned)

  assert.equal(normalizedCuePositionToTicks(cuePosition, loopDurationTicks), cueTicks)
  assert.equal(
    normalizedCuePositionToTicks(pointerPosition, loopDurationTicks),
    normalizedCuePositionToTicks((panned.start + panned.end) / 2, loopDurationTicks),
  )
  assert.deepEqual(createCueViewport(), { zoomLevel: 1, start: 0, end: 1 })
})
