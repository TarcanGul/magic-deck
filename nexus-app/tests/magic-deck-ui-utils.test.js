import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createMagicStatusController,
  isDeckFxAvailable,
  magicRestingStatus,
} from '../src/magic-deck-ui-utils.js'

function fxOptions(overrides = {}) {
  return {
    projectConnected: true,
    hasProjectDocument: true,
    deckIndex: 2,
    pendingCount: 0,
    activeKind: null,
    hasPlayableMagicContent: false,
    activeFxDeckIndex: null,
    hasActiveLibrary: false,
    ...overrides,
  }
}

test('keeps FX disabled during an initial Magic generation without playable content', () => {
  assert.equal(isDeckFxAvailable(fxOptions({
    pendingCount: 1,
    activeKind: 'generating',
  })), false)
})

test('keeps FX available while regenerating playable Magic content', () => {
  assert.equal(isDeckFxAvailable(fxOptions({
    pendingCount: 1,
    activeKind: 'generating',
    hasPlayableMagicContent: true,
  })), true)
})

test('makes FX available after generation completes', () => {
  assert.equal(isDeckFxAvailable(fxOptions({
    hasPlayableMagicContent: true,
  })), true)
})

test('keeps the connected empty-deck FX behavior outside generation', () => {
  assert.equal(isDeckFxAvailable(fxOptions()), true)
})

test('disables FX after project disconnection', () => {
  assert.equal(isDeckFxAvailable(fxOptions({
    projectConnected: false,
    hasPlayableMagicContent: true,
  })), false)
})

test('preserves pending-operation FX behavior for source decks', () => {
  assert.equal(isDeckFxAvailable(fxOptions({
    deckIndex: 0,
    pendingCount: 1,
    activeKind: 'loading',
    hasPlayableMagicContent: true,
  })), false)
})

test('selects empty, generated, and restored resting statuses', () => {
  assert.deepEqual(magicRestingStatus('empty'), { state: 'idle', label: 'IDLE' })
  assert.deepEqual(magicRestingStatus('generated', '16 BARS · 120 BPM'), {
    state: 'done',
    label: 'GENERATED · 16 BARS · 120 BPM',
  })
  assert.deepEqual(magicRestingStatus('restored', 'magic.wav · 0:32'), {
    state: 'done',
    label: 'RESTORED · magic.wav · 0:32',
  })
})

test('temporary statuses recover to the latest resting content and stale resets are cancelled', () => {
  const callbacks = new Map()
  const cleared = []
  let nextTimer = 0
  const rendered = []
  const controller = createMagicStatusController(
    (status) => rendered.push(status),
    {
      setTimeout(callback) {
        const timer = ++nextTimer
        callbacks.set(timer, callback)
        return timer
      },
      clearTimeout(timer) {
        cleared.push(timer)
        callbacks.delete(timer)
      },
    },
  )

  controller.setResting('restored', 'old.wav')
  controller.showTemporary({ state: 'warning', label: 'TIMING WARNING' }, 8000)
  controller.setResting('generated', '16 BARS · 128 BPM')
  controller.showTemporary({ state: 'error', label: 'NETWORK ERROR' }, 4000)
  callbacks.get(2)()

  assert.deepEqual(cleared, [1])
  assert.deepEqual(rendered.at(-1), {
    state: 'done',
    label: 'GENERATED · 16 BARS · 128 BPM',
  })
})
