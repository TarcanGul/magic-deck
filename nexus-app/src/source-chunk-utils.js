export const SOURCE_UPLOAD_SETTINGS_KEY = 'magic-deck:source-upload:v1'

export const DEFAULT_SOURCE_UPLOAD_SETTINGS = Object.freeze({
  chunkingEnabled: true,
  chunkDurationSeconds: 30,
  uploadConcurrency: 3,
})

function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)))
}

export function normalizeSourceUploadSettings(value = {}) {
  return {
    chunkingEnabled: typeof value?.chunkingEnabled === 'boolean'
      ? value.chunkingEnabled
      : DEFAULT_SOURCE_UPLOAD_SETTINGS.chunkingEnabled,
    chunkDurationSeconds: clampInteger(
      value?.chunkDurationSeconds,
      10,
      120,
      DEFAULT_SOURCE_UPLOAD_SETTINGS.chunkDurationSeconds,
    ),
    uploadConcurrency: clampInteger(
      value?.uploadConcurrency,
      1,
      6,
      DEFAULT_SOURCE_UPLOAD_SETTINGS.uploadConcurrency,
    ),
  }
}

export function loadSourceUploadSettings(storage) {
  try {
    const raw = storage?.getItem(SOURCE_UPLOAD_SETTINGS_KEY)
    return normalizeSourceUploadSettings(raw ? JSON.parse(raw) : undefined)
  } catch {
    return { ...DEFAULT_SOURCE_UPLOAD_SETTINGS }
  }
}

export function saveSourceUploadSettings(storage, settings) {
  const normalized = normalizeSourceUploadSettings(settings)
  storage?.setItem(SOURCE_UPLOAD_SETTINGS_KEY, JSON.stringify(normalized))
  return normalized
}

export function normalizedCuePositions(cueSlots) {
  return cueSlots
    .map((position, cueSlot) => ({ position: Number(position), cueSlot }))
    .filter(({ position }) => Number.isFinite(position) && position > 0 && position < 1)
    .sort((left, right) => left.cueSlot - right.cueSlot)
}

export function scaleCuePositions(cueSlots, durationFrames) {
  if (!Number.isInteger(durationFrames) || durationFrames < 1) {
    throw new RangeError('Audio duration must contain at least one frame')
  }
  return normalizedCuePositions(cueSlots).map(({ position, cueSlot }) => ({
    cueSlot,
    position,
    frame: Math.min(durationFrames - 1, Math.max(1, Math.round(position * durationFrames))),
  }))
}

export function planSourceChunks({
  durationFrames,
  sampleRate,
  cueSlots = [],
  maximumSeconds = DEFAULT_SOURCE_UPLOAD_SETTINGS.chunkDurationSeconds,
  chunkingEnabled = true,
}) {
  if (!Number.isInteger(durationFrames) || durationFrames < 1) {
    throw new RangeError('Audio duration must contain at least one frame')
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('Sample rate must be positive')
  }
  const maximumFrames = chunkingEnabled
    ? Math.max(1, Math.round(clampInteger(maximumSeconds, 10, 120, 30) * sampleRate))
    : durationFrames
  const scaledCues = scaleCuePositions(cueSlots, durationFrames)
  const cueByFrame = new Map()
  scaledCues.forEach((cue) => {
    const slots = cueByFrame.get(cue.frame) ?? []
    slots.push(cue.cueSlot)
    cueByFrame.set(cue.frame, slots)
  })
  const hardBoundaries = [...new Set([0, ...scaledCues.map((cue) => cue.frame), durationFrames])]
    .sort((left, right) => left - right)
  const chunks = []
  for (let boundaryIndex = 0; boundaryIndex < hardBoundaries.length - 1; boundaryIndex++) {
    const spanStart = hardBoundaries[boundaryIndex]
    const spanEnd = hardBoundaries[boundaryIndex + 1]
    for (let startFrame = spanStart; startFrame < spanEnd; startFrame += maximumFrames) {
      const endFrame = Math.min(spanEnd, startFrame + maximumFrames)
      chunks.push({
        index: chunks.length,
        startFrame,
        endFrame,
        frameLength: endFrame - startFrame,
        startSeconds: startFrame / sampleRate,
        durationSeconds: (endFrame - startFrame) / sampleRate,
        cueSlots: [...(cueByFrame.get(startFrame) ?? [])],
      })
    }
  }
  return chunks
}

export function prioritizeSourceChunks(chunks) {
  return [...chunks].sort((left, right) => {
    if (left.startFrame === 0) return right.startFrame === 0 ? 0 : -1
    if (right.startFrame === 0) return 1
    const leftCue = left.cueSlots[0]
    const rightCue = right.cueSlots[0]
    if (leftCue !== undefined || rightCue !== undefined) {
      if (leftCue === undefined) return 1
      if (rightCue === undefined) return -1
      return leftCue - rightCue || left.startFrame - right.startFrame
    }
    return left.startFrame - right.startFrame
  })
}

export function audioChannelsSlice(channels, startFrame, endFrame) {
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) {
    throw new RangeError('PCM slice boundaries are invalid')
  }
  return channels.map((channel) => channel.slice(startFrame, endFrame))
}

export function encodePcm16Wav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length < 1) {
    throw new RangeError('At least one PCM channel is required')
  }
  const frameLength = channels[0].length
  if (!channels.every((channel) => channel.length === frameLength)) {
    throw new RangeError('PCM channels must have equal lengths')
  }
  const channelCount = channels.length
  const bytesPerSample = 2
  const dataLength = frameLength * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataLength, true)
  let offset = 44
  for (let frame = 0; frame < frameLength; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0))
      view.setInt16(offset, value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff), true)
      offset += bytesPerSample
    }
  }
  return buffer
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const limit = clampInteger(concurrency, 1, 6, 1)
  const results = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

export async function retryWithBackoff(task, {
  attempts = 3,
  baseDelayMs = 250,
  signal,
  wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  onAttempt = () => undefined,
  onFailure = () => undefined,
} = {}) {
  const maximumAttempts = Math.max(1, Math.round(attempts))
  let lastError
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Operation cancelled')
    onAttempt(attempt)
    try {
      return await task(attempt)
    } catch (error) {
      lastError = error
      await onFailure(error, attempt)
      if (attempt === maximumAttempts) break
      await wait(baseDelayMs * (2 ** (attempt - 1)), signal)
    }
  }
  throw lastError
}

export function aggregateChunkProgress(chunks, phase = 'uploading') {
  const total = chunks.length
  const ready = chunks.filter((chunk) => chunk.state === 'ready').length
  const failed = chunks.filter((chunk) => chunk.state === 'failed').length
  const retrying = chunks.filter((chunk) => chunk.state === 'retrying').length
  const attempts = chunks.reduce((sum, chunk) => sum + (chunk.attempts ?? 0), 0)
  return { total, ready, failed, retrying, attempts, phase }
}

export function logicalTrackContains(group, regionId, sessionId) {
  return Boolean(
    group
    && group.sessionId === sessionId
    && group.regions.some((region) => region.id === regionId),
  )
}

export function transitionUploadPhase(current, next) {
  const order = ['decoding', 'uploading', 'chunks-ready', 'consolidating', 'ready']
  if (next === 'failed' || next === 'cancelled') return next
  if (current === 'failed' || current === 'cancelled') return current
  if (order.indexOf(next) < order.indexOf(current)) {
    throw new Error(`Upload phase cannot move from ${current} to ${next}`)
  }
  return next
}
