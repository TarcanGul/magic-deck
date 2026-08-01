import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DECK_FILTER_MAX_HZ,
  DECK_FILTER_MIN_HZ,
  filterFrequencyToValue,
  filterValueToFrequency,
  neutralFilterValue,
} from '../src/deck-filter-utils.js'

test('maps filter knob endpoints to the Audiotool trim-filter range', () => {
  assert.equal(filterValueToFrequency(0), DECK_FILTER_MIN_HZ)
  assert.equal(filterValueToFrequency(1), DECK_FILTER_MAX_HZ)
  assert.equal(filterValueToFrequency(-1), DECK_FILTER_MIN_HZ)
  assert.equal(filterValueToFrequency(2), DECK_FILTER_MAX_HZ)
})

test('uses a logarithmic filter-frequency scale', () => {
  assert.ok(Math.abs(filterValueToFrequency(0.5) - Math.sqrt(400000)) < 1e-9)
})

test('round trips filter frequencies and clamps invalid endpoints', () => {
  for (const frequency of [20, 80, 440, 2000, 12000, 20000]) {
    assert.ok(Math.abs(filterValueToFrequency(filterFrequencyToValue(frequency)) - frequency) < 1e-9)
  }
  assert.equal(filterFrequencyToValue(1), 0)
  assert.equal(filterFrequencyToValue(30000), 1)
})

test('uses open filter cutoffs as the neutral knob positions', () => {
  assert.equal(neutralFilterValue('hpf'), 0)
  assert.equal(neutralFilterValue('lpf'), 1)
})
