export const UPLOAD_PHASES = Object.freeze([
  'preparing',
  'uploading',
  'detecting-bpm',
  'processing',
  'inserting',
  'ready',
  'failed',
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function callTask(start) {
  try {
    return Promise.resolve(start())
  } catch (error) {
    return Promise.reject(error)
  }
}

export function startConcurrentTasks(starters) {
  const upload = callTask(starters.upload)
  const bpm = callTask(starters.bpm)
  const duration = callTask(starters.duration)
  return { upload, bpm, duration }
}

export function createPerKeyTaskQueue(keyCount) {
  if (!Number.isInteger(keyCount) || keyCount < 1) {
    throw new RangeError('Queue key count must be a positive integer')
  }
  const queues = Array.from({ length: keyCount }, () => Promise.resolve())
  return {
    enqueue(key, task) {
      if (!Number.isInteger(key) || key < 0 || key >= queues.length) {
        return Promise.reject(new RangeError('Queue key is out of range'))
      }
      const queued = queues[key].then(task, task)
      queues[key] = queued.then(() => undefined, () => undefined)
      return queued
    },
  }
}

export function isCurrentSession(expectedSession, currentSession) {
  return expectedSession === currentSession
}

export function isSupportedBpmValue(value, minimum = 40, maximum = 240) {
  return Number.isFinite(value) && value >= minimum && value <= maximum
}

export function resolveBpmRace(
  audiotoolBpm,
  aubioResult,
  {
    minimum = 40,
    maximum = 240,
    confidenceThreshold = 0.8,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false
    let audiotoolSettled = false
    let aubioSettled = false
    let aubioEstimate = null
    let aubioFailure = null

    const finishFallback = () => {
      if (settled || !audiotoolSettled || !aubioSettled) return
      settled = true
      resolve({
        kind: 'confirmation',
        estimate: aubioEstimate,
        aubioError: aubioFailure,
      })
    }

    Promise.resolve(audiotoolBpm).then((value) => {
      if (settled) return
      audiotoolSettled = true
      if (isSupportedBpmValue(value, minimum, maximum)) {
        settled = true
        resolve({ kind: 'accepted', bpm: value, source: 'audiotool' })
        return
      }
      finishFallback()
    }, (error) => {
      audiotoolSettled = true
      if (settled) return
      settled = true
      reject(error)
    })

    Promise.resolve(aubioResult).then((estimate) => {
      if (settled) return
      aubioSettled = true
      const bpm = Number(estimate?.bpm)
      const confidence = Number(estimate?.confidence)
      aubioEstimate = {
        bpm: isSupportedBpmValue(bpm, minimum, maximum) ? bpm : null,
        confidence: Number.isFinite(confidence) ? confidence : 0,
        reliable: Boolean(estimate?.reliable),
      }
      if (
        aubioEstimate.bpm !== null
        && aubioEstimate.confidence > confidenceThreshold
      ) {
        settled = true
        resolve({ kind: 'accepted', bpm: aubioEstimate.bpm, source: 'aubio' })
        return
      }
      finishFallback()
    }, (error) => {
      if (settled) return
      aubioSettled = true
      aubioFailure = errorMessage(error)
      finishFallback()
    })
  })
}

export function createUploadTimingRecorder({
  now = () => performance.now(),
  onChange = () => undefined,
} = {}) {
  const origin = now()
  const active = new Set()
  const timings = {}
  let outcome = 'pending'
  let failure = null

  const relativeNow = () => Math.max(0, now() - origin)
  const snapshot = () => ({
    outcome,
    active: UPLOAD_PHASES.filter((phase) => active.has(phase)),
    timings: Object.fromEntries(
      UPLOAD_PHASES
        .filter((phase) => timings[phase])
        .map((phase) => [phase, { ...timings[phase] }]),
    ),
    totalDurationMs: relativeNow(),
    failure,
  })
  const notify = () => onChange(snapshot())

  return {
    begin(phase) {
      if (!UPLOAD_PHASES.includes(phase)) throw new RangeError(`Unknown upload phase: ${phase}`)
      if (!timings[phase]) timings[phase] = { startedAtMs: relativeNow() }
      active.add(phase)
      notify()
    },
    end(phase, stageOutcome = 'completed') {
      const timing = timings[phase]
      if (!timing) return
      const completedAtMs = relativeNow()
      timing.completedAtMs = completedAtMs
      timing.durationMs = Math.max(0, completedAtMs - timing.startedAtMs)
      timing.outcome = stageOutcome
      active.delete(phase)
      notify()
    },
    fail(error) {
      outcome = 'failed'
      failure = errorMessage(error)
      for (const phase of [...active]) this.end(phase, 'failed')
      this.begin('failed')
      this.end('failed', 'failed')
    },
    complete(details = {}) {
      if (outcome === 'pending') outcome = 'ready'
      return { ...snapshot(), ...details }
    },
    snapshot,
  }
}

export function uploadProgressText(progress) {
  const active = new Set(progress?.active ?? [])
  if (active.has('failed')) return 'TRACK LOAD FAILED'
  if (active.has('inserting')) return 'INSERTING PROJECT REGION'
  if (active.has('uploading') && active.has('detecting-bpm')) {
    return 'UPLOADING TO AUDIOTOOL · DETECTING BPM'
  }
  if (active.has('uploading')) return 'UPLOADING TO AUDIOTOOL'
  if (active.has('processing') && active.has('detecting-bpm')) {
    return 'UPLOAD COMPLETE · DETECTING BPM'
  }
  if (active.has('processing')) return 'PROCESSING IN AUDIOTOOL'
  if (active.has('detecting-bpm')) return 'UPLOAD READY · CONFIRM SOURCE BPM'
  if (active.has('preparing')) return 'PREPARING LOCAL AUDIO'
  if (active.has('ready')) return 'TRACK READY'
  return ''
}

export async function settlePendingInsertion(ready, inserted, handlers) {
  try {
    const sample = await ready
    await handlers.hydrate(inserted, sample)
    return sample
  } catch (error) {
    try {
      await handlers.cleanup(inserted)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Sample processing failed and pending insertion cleanup also failed: ${errorMessage(error)}`,
      )
    }
    throw error
  }
}
