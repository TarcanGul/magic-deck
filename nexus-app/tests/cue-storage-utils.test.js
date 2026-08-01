import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadCuePointMetadata,
  parseCueRecordV2,
  saveCuePointMetadata,
} from '../src/cue-storage-utils.js'

const footprint = 'audio-123'
const empty = [null, null, null, null, null]

function adapters(overrides = {}) {
  const written = { persistent: null, session: null, removed: false }
  return {
    written,
    options: {
      audioFootprint: footprint,
      authoritativePoints: [],
      readPersistent: async () => null,
      readSession: async () => null,
      writePersistent: async (record) => { written.persistent = record },
      writeSession: async (record) => { written.session = record },
      removeSession: async () => { written.removed = true },
      now: () => 123,
      ...overrides,
    },
  }
}

test('migrates session-only cue ordering to IndexedDB', async () => {
  const legacy = [0.5, null, 0.25, null, null]
  const fixture = adapters({
    readSession: async () => ({ version: 1, audioFootprint: footprint, points: legacy }),
  })
  const result = await loadCuePointMetadata(fixture.options)
  assert.deepEqual(result, { points: legacy, persistence: 'indexeddb', migrated: true })
  assert.deepEqual(fixture.written.persistent, {
    version: 2, audioFootprint: footprint, points: legacy, updatedAt: 123,
  })
  assert.equal(fixture.written.removed, true)
})

test('migrates authoritative project cuts without session metadata', async () => {
  const fixture = adapters({ authoritativePoints: [0.25, 0.75] })
  const result = await loadCuePointMetadata(fixture.options)
  assert.deepEqual(result.points, [0.25, 0.75, null, null, null])
})

test('uses session slots for matching authoritative project cuts', async () => {
  const fixture = adapters({
    authoritativePoints: [0.25001, 0.5],
    readSession: async () => ({
      version: 1,
      audioFootprint: footprint,
      points: [0.5, null, 0.25, null, null],
    }),
  })
  const result = await loadCuePointMetadata(fixture.options)
  assert.deepEqual(result.points, [0.5, null, 0.25001, null, null])
})

test('replaces malformed persistent records during migration', async () => {
  const fixture = adapters({
    readPersistent: async () => ({
      version: 2, audioFootprint: footprint, points: [2], updatedAt: 'yesterday',
    }),
  })
  const result = await loadCuePointMetadata(fixture.options)
  assert.deepEqual(result.points, empty)
  assert.equal(result.migrated, true)
  assert.equal(parseCueRecordV2(fixture.written.persistent, footprint)?.updatedAt, 123)
})

test('keeps session fallback when IndexedDB fails', async () => {
  const failure = new Error('IndexedDB blocked')
  const fixture = adapters({
    authoritativePoints: [0.25],
    readPersistent: async () => { throw failure },
  })
  const result = await loadCuePointMetadata(fixture.options)
  assert.equal(result.persistence, 'session')
  assert.equal(result.error, failure)
  assert.deepEqual(fixture.written.session?.points, [0.25, null, null, null, null])
  assert.equal(fixture.written.removed, false)
})

test('falls back to session storage when a later persistent save fails', async () => {
  const fixture = adapters({
    writePersistent: async () => { throw new Error('quota') },
  })
  const result = await saveCuePointMetadata({
    audioFootprint: footprint,
    points: [0, null, 0.5, null, null],
    writePersistent: fixture.options.writePersistent,
    writeSession: fixture.options.writeSession,
    now: () => 456,
  })
  assert.equal(result.persistence, 'session')
  assert.deepEqual(fixture.written.session?.points, [0, null, 0.5, null, null])
})
