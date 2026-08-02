import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE_UPLOAD_SETTINGS_KEY,
  audioChannelsSlice,
  encodePcm16Wav,
  loadSourceUploadSettings,
  logicalTrackContains,
  mapWithConcurrency,
  planSourceChunks,
  prioritizeSourceChunks,
  retryWithBackoff,
  saveSourceUploadSettings,
  transitionUploadPhase,
} from '../src/source-chunk-utils.js'

test('partitions at cue boundaries and subdivides spans to the configured maximum', () => {
  const chunks = planSourceChunks({
    durationFrames: 1_000,
    sampleRate: 10,
    cueSlots: [0.25, 0.8, null, null, null],
    maximumSeconds: 30,
  })
  assert.deepEqual(chunks.map(({ startFrame, endFrame }) => [startFrame, endFrame]), [
    [0, 250], [250, 550], [550, 800], [800, 1_000],
  ])
  assert.ok(chunks.every((chunk) => chunk.frameLength <= 300))
  assert.deepEqual(chunks[1].cueSlots, [0])
  assert.deepEqual(chunks[3].cueSlots, [1])
})

test('prioritizes the opening chunk, cue starts in slot order, then chronology', () => {
  const planned = planSourceChunks({
    durationFrames: 1_200,
    sampleRate: 10,
    cueSlots: [0.75, 0.25, null, null, null],
    maximumSeconds: 20,
  })
  assert.deepEqual(
    prioritizeSourceChunks(planned).map((chunk) => chunk.startFrame),
    [0, 900, 300, 200, 500, 700, 1_100],
  )
})

test('uses exact PCM boundaries and writes interleaved 16-bit WAV data', () => {
  const channels = [new Float32Array([0, 0.5, 1, -1]), new Float32Array([1, 0, -0.5, -1])]
  const sliced = audioChannelsSlice(channels, 1, 3)
  assert.deepEqual(Array.from(sliced[0]), [0.5, 1])
  assert.deepEqual(Array.from(sliced[1]), [0, -0.5])
  const wav = encodePcm16Wav(sliced, 48_000)
  const view = new DataView(wav)
  assert.equal(wav.byteLength, 52)
  assert.equal(view.getUint16(22, true), 2)
  assert.equal(view.getUint32(24, true), 48_000)
  assert.equal(view.getInt16(44, true), 16_384)
  assert.equal(view.getInt16(46, true), 0)
  assert.equal(view.getInt16(48, true), 32_767)
  assert.equal(view.getInt16(50, true), -16_384)
})

test('bounds parallel workers while retaining result order', async () => {
  let active = 0
  let maximumActive = 0
  const result = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, value % 2 ? 2 : 1))
    active -= 1
    return value * 2
  })
  assert.equal(maximumActive, 2)
  assert.deepEqual(result, [0, 2, 4, 6, 8])
})

test('retries only the failed task for three total attempts with exponential backoff', async () => {
  const attempts = []
  const delays = []
  const result = await retryWithBackoff((attempt) => {
    attempts.push(attempt)
    if (attempt < 3) throw new Error('temporary')
    return 'ready'
  }, { wait: (delay) => delays.push(delay) })
  assert.equal(result, 'ready')
  assert.deepEqual(attempts, [1, 2, 3])
  assert.deepEqual(delays, [250, 500])
})

test('surfaces three-attempt exhaustion', async () => {
  let attempts = 0
  await assert.rejects(retryWithBackoff(() => {
    attempts += 1
    throw new Error('processing failed')
  }, { wait: () => undefined }), /processing failed/)
  assert.equal(attempts, 3)
})

test('loads, clamps, and persists source upload settings', () => {
  const values = new Map([[SOURCE_UPLOAD_SETTINGS_KEY, JSON.stringify({
    chunkingEnabled: false,
    chunkDurationSeconds: 500,
    uploadConcurrency: 0,
  })]])
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
  assert.deepEqual(loadSourceUploadSettings(storage), {
    chunkingEnabled: false,
    chunkDurationSeconds: 120,
    uploadConcurrency: 1,
  })
  assert.deepEqual(saveSourceUploadSettings(storage, {
    chunkingEnabled: true,
    chunkDurationSeconds: 10,
    uploadConcurrency: 6,
  }), { chunkingEnabled: true, chunkDurationSeconds: 10, uploadConcurrency: 6 })
})

test('checks logical membership by session and rejects phase regression', () => {
  const group = { sessionId: 4, regions: [{ id: 'a' }, { id: 'b' }] }
  assert.equal(logicalTrackContains(group, 'b', 4), true)
  assert.equal(logicalTrackContains(group, 'b', 5), false)
  assert.equal(transitionUploadPhase('uploading', 'consolidating'), 'consolidating')
  assert.throws(() => transitionUploadPhase('consolidating', 'uploading'), /cannot move/)
})
