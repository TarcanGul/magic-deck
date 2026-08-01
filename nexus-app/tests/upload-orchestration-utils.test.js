import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPerKeyTaskQueue,
  createUploadTimingRecorder,
  isCurrentSession,
  resolveBpmRace,
  settlePendingInsertion,
  startConcurrentTasks,
  uploadProgressText,
} from '../src/upload-orchestration-utils.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('starts upload, BPM detection, and duration decoding without awaiting another task', async () => {
  const calls = []
  const gates = [deferred(), deferred(), deferred()]
  const tasks = startConcurrentTasks({
    upload: () => { calls.push('upload'); return gates[0].promise },
    bpm: () => { calls.push('bpm'); return gates[1].promise },
    duration: () => { calls.push('duration'); return gates[2].promise },
  })
  assert.deepEqual(calls, ['upload', 'bpm', 'duration'])
  gates.forEach((gate, index) => gate.resolve(index))
  assert.deepEqual(await Promise.all([tasks.upload, tasks.bpm, tasks.duration]), [0, 1, 2])
})

test('accepts whichever reliable BPM source resolves first', async () => {
  const audiotool = deferred()
  const aubio = deferred()
  const decision = resolveBpmRace(audiotool.promise, aubio.promise)
  aubio.resolve({ bpm: 128, confidence: 0.91, reliable: true })
  assert.deepEqual(await decision, { kind: 'accepted', bpm: 128, source: 'aubio' })
  audiotool.resolve(126)

  const audiotoolFirst = deferred()
  const aubioLater = deferred()
  const metadataDecision = resolveBpmRace(audiotoolFirst.promise, aubioLater.promise)
  audiotoolFirst.resolve(124)
  assert.deepEqual(await metadataDecision, { kind: 'accepted', bpm: 124, source: 'audiotool' })
  aubioLater.resolve({ bpm: 123, confidence: 0.99, reliable: true })
})

test('waits for Audiotool metadata before surfacing a low-confidence Aubio estimate', async () => {
  const audiotool = deferred()
  const aubio = deferred()
  let settled = false
  const decision = resolveBpmRace(audiotool.promise, aubio.promise).then((value) => {
    settled = true
    return value
  })
  aubio.resolve({ bpm: 129, confidence: 0.42, reliable: false })
  await Promise.resolve()
  assert.equal(settled, false)
  audiotool.resolve(0)
  assert.deepEqual(await decision, {
    kind: 'confirmation',
    estimate: { bpm: 129, confidence: 0.42, reliable: false },
    aubioError: null,
  })
})

test('isolates Aubio failure and accepts later Audiotool metadata', async () => {
  const audiotool = deferred()
  const aubio = deferred()
  const decision = resolveBpmRace(audiotool.promise, aubio.promise)
  aubio.reject(new Error('aubio unavailable'))
  audiotool.resolve(120)
  assert.deepEqual(await decision, { kind: 'accepted', bpm: 120, source: 'audiotool' })
})

test('supports aborting concurrent work after upload failure', async () => {
  const controller = new AbortController()
  const uploadFailure = Promise.reject(new Error('transfer failed'))
  const abortable = new Promise((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
  })
  await assert.rejects(uploadFailure.catch((error) => {
    controller.abort(error)
    throw error
  }), /transfer failed/)
  await assert.rejects(abortable, /transfer failed/)
})

test('records overlapping monotonic phase timings and phase-aware text', () => {
  let clock = 100
  const snapshots = []
  const recorder = createUploadTimingRecorder({
    now: () => clock,
    onChange: (snapshot) => snapshots.push(snapshot),
  })
  recorder.begin('preparing')
  recorder.begin('uploading')
  recorder.begin('detecting-bpm')
  assert.equal(uploadProgressText(recorder.snapshot()), 'UPLOADING TO AUDIOTOOL · DETECTING BPM')
  clock = 118
  recorder.end('preparing')
  clock = 145
  recorder.end('uploading')
  recorder.begin('processing')
  assert.equal(uploadProgressText(recorder.snapshot()), 'UPLOAD COMPLETE · DETECTING BPM')
  clock = 180
  recorder.end('detecting-bpm')
  clock = 220
  recorder.end('processing')
  recorder.begin('inserting')
  assert.equal(uploadProgressText(recorder.snapshot()), 'INSERTING PROJECT REGION')
  clock = 235
  recorder.end('inserting')
  recorder.begin('ready')
  recorder.end('ready')
  const result = recorder.complete({ deck: 1 })
  assert.equal(result.deck, 1)
  assert.equal(result.timings.uploading.durationMs, 45)
  assert.equal(result.timings.processing.durationMs, 75)
  assert.equal(result.totalDurationMs, 135)
  assert.ok(snapshots.length >= 10)
})

test('rejects stale sessions without conflating them with current work', () => {
  assert.equal(isCurrentSession(7, 7), true)
  assert.equal(isCurrentSession(7, 8), false)
})

test('removes only the pending insertion if processing fails', async () => {
  const removed = []
  const hydrated = []
  await assert.rejects(settlePendingInsertion(
    Promise.reject(new Error('processing failed')),
    { regionId: 'pending-region' },
    {
      hydrate: (inserted) => hydrated.push(inserted.regionId),
      cleanup: (inserted) => removed.push(inserted.regionId),
    },
  ), /processing failed/)
  assert.deepEqual(hydrated, [])
  assert.deepEqual(removed, ['pending-region'])
})

test('orders same-deck tasks while allowing Deck A and Deck B to overlap', async () => {
  const queue = createPerKeyTaskQueue(2)
  const firstA = deferred()
  const firstB = deferred()
  const events = []
  const a1 = queue.enqueue(0, async () => { events.push('a1:start'); await firstA.promise; events.push('a1:end') })
  const a2 = queue.enqueue(0, () => { events.push('a2:start') })
  const b1 = queue.enqueue(1, async () => { events.push('b1:start'); await firstB.promise; events.push('b1:end') })
  await Promise.resolve()
  assert.deepEqual(events, ['a1:start', 'b1:start'])
  firstB.resolve()
  await b1
  assert.deepEqual(events, ['a1:start', 'b1:start', 'b1:end'])
  firstA.resolve()
  await Promise.all([a1, a2])
  assert.deepEqual(events, ['a1:start', 'b1:start', 'b1:end', 'a1:end', 'a2:start'])
})
