import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE_CHUNK_MANIFEST_PREFIX,
  SOURCE_UPLOAD_SETTINGS_KEY,
  audioChannelsSlice,
  createSourceChunkManifest,
  encodePcm16Wav,
  formatSourceChunkManifest,
  loadSourceUploadSettings,
  logicalChunkDuration,
  logicalTrackContains,
  mapWithConcurrency,
  parseSourceChunkManifest,
  planSourceChunks,
  planSourceChunkSuffix,
  prioritizeSourceChunks,
  reconstructLogicalChunkGroups,
  resolveCueToSourceChunk,
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
  assert.equal(transitionUploadPhase('chunks-ready', 'ready'), 'ready')
  assert.throws(() => transitionUploadPhase('ready', 'uploading'), /cannot move/)
})

const manifest = (partIndex, startFrame, endFrame, overrides = {}) => createSourceChunkManifest({
  groupId: 'group-1',
  audioFootprint: 'sha256-full-track',
  fileName: 'track.wav',
  partIndex,
  partCount: 3,
  startFrame,
  endFrame,
  totalFrames: 1_000,
  sampleRate: 100,
  ...overrides,
})

test('round trips durable source chunk manifests and rejects malformed metadata', () => {
  const expected = manifest(1, 300, 700)
  const compact = formatSourceChunkManifest(expected)
  assert.deepEqual(parseSourceChunkManifest(compact), expected)
  assert.ok(compact.length < 220)
  assert.deepEqual(
    parseSourceChunkManifest(`notes\n${compact}\nignored`),
    expected,
  )
  assert.deepEqual(
    parseSourceChunkManifest(`${SOURCE_CHUNK_MANIFEST_PREFIX}${JSON.stringify(expected)}`),
    expected,
  )
  assert.equal(parseSourceChunkManifest('ordinary sample description'), null)
  assert.equal(parseSourceChunkManifest('magic-deck:source-chunk:v1:{bad json'), null)
})

test('reconstructs deterministic complete groups from manifests', () => {
  const entries = [
    { regionId: 'r3', sampleId: 's3', positionTicks: 70, durationTicks: 30, description: formatSourceChunkManifest(manifest(2, 700, 1_000)) },
    { regionId: 'r1', sampleId: 's1', positionTicks: 0, durationTicks: 30, description: formatSourceChunkManifest(manifest(0, 0, 300)) },
    { regionId: 'r2', sampleId: 's2', positionTicks: 30, durationTicks: 40, description: formatSourceChunkManifest(manifest(1, 300, 700)) },
  ]
  const groups = reconstructLogicalChunkGroups(entries)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].durationSeconds, 10)
  assert.deepEqual(groups[0].regions.map((region) => region.regionId), ['r1', 'r2', 'r3'])
  assert.equal(logicalChunkDuration(groups[0].regions.map((region) => region.manifest)), 10)
})

test('rejects incomplete and ambiguous manifest groups but accepts complete suffix instances', () => {
  const suffix = [
    { regionId: 'r2', sampleId: 's2', positionTicks: 200, durationTicks: 40, description: formatSourceChunkManifest(manifest(1, 300, 700)) },
    { regionId: 'r3', sampleId: 's3', positionTicks: 240, durationTicks: 30, description: formatSourceChunkManifest(manifest(2, 700, 1_000)) },
  ]
  assert.deepEqual(reconstructLogicalChunkGroups(suffix), [])
  assert.equal(reconstructLogicalChunkGroups(suffix, { allowSuffixes: true })[0].startPartIndex, 1)
  const ambiguous = [
    { ...suffix[0] },
    { ...suffix[0], regionId: 'r2b', description: formatSourceChunkManifest(manifest(1, 301, 700)) },
    suffix[1],
  ]
  assert.deepEqual(reconstructLogicalChunkGroups(ambiguous, { allowSuffixes: true }), [])
})

test('reconstructs a stopped logical instance from natural chunk spans', () => {
  const groups = reconstructLogicalChunkGroups([
    { regionId: 'r1', sampleId: 's1', positionTicks: 0, durationTicks: 12, logicalDurationTicks: 30, description: formatSourceChunkManifest(manifest(0, 0, 300)) },
    { regionId: 'r2', sampleId: 's2', positionTicks: 30, durationTicks: 40, logicalDurationTicks: 40, description: formatSourceChunkManifest(manifest(1, 300, 700)) },
    { regionId: 'r3', sampleId: 's3', positionTicks: 70, durationTicks: 30, logicalDurationTicks: 30, description: formatSourceChunkManifest(manifest(2, 700, 1_000)) },
  ])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].regions.map((region) => region.regionId), ['r1', 'r2', 'r3'])
})

test('reconstructs the current PART naming format as a legacy fallback', () => {
  const groups = reconstructLogicalChunkGroups([
    { regionId: 'a', sampleId: 'sa', positionTicks: 10, durationTicks: 25, durationSeconds: 2.5, displayName: 'DECK 1 — old.wav · PART 1/2' },
    { regionId: 'b', sampleId: 'sb', positionTicks: 35, durationTicks: 35, durationSeconds: 3.5, displayName: 'DECK 1 — old.wav · PART 2/2' },
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].legacy, true)
  assert.equal(groups[0].durationSeconds, 6)
})

test('resolves cues before, on, and after chunk boundaries with final-frame rounding', () => {
  const chunks = [manifest(0, 0, 300), manifest(1, 300, 700), manifest(2, 700, 1_000)]
  assert.deepEqual(resolveCueToSourceChunk(chunks, 0.299).manifest.partIndex, 0)
  assert.deepEqual(resolveCueToSourceChunk(chunks, 0.3).manifest.partIndex, 1)
  assert.deepEqual(resolveCueToSourceChunk(chunks, 0.701).manifest.partIndex, 2)
  const final = resolveCueToSourceChunk(chunks, 0.9999)
  assert.equal(final.absoluteFrame, 999)
  assert.equal(final.localFrame, 299)
})

test('plans a contiguous cue suffix with chunk-local offset and independent terminals', () => {
  const plan = planSourceChunkSuffix({
    chunks: [
      { manifest: manifest(0, 0, 300), durationTicks: 30 },
      { manifest: manifest(1, 300, 700), durationTicks: 40 },
      { manifest: manifest(2, 700, 1_000), durationTicks: 30 },
    ],
    cuePosition: 0.5,
    targetPositionTicks: 1_000,
  })
  assert.deepEqual(plan.chunks.map((chunk) => ({
    part: chunk.manifest.partIndex,
    position: chunk.positionTicks,
    duration: chunk.durationTicks,
    offset: chunk.collectionOffsetTicks,
    terminal: chunk.automationTerminalTicks,
    fadeIn: chunk.includeFadeIn,
    fadeOut: chunk.includeFadeOut,
  })), [
    { part: 1, position: 1_000, duration: 20, offset: 20, terminal: 40, fadeIn: true, fadeOut: false },
    { part: 2, position: 1_020, duration: 30, offset: 0, terminal: 30, fadeIn: false, fadeOut: true },
  ])
  assert.equal(plan.totalRemainingDurationTicks, 50)
})
