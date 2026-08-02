export const SOURCE_UPLOAD_SETTINGS_KEY = 'magic-deck:source-upload:v1'
export const SOURCE_CHUNK_MANIFEST_PREFIX = 'magic-deck:source-chunk:v1:'

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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export function createSourceChunkManifest({
  groupId,
  audioFootprint,
  fileName,
  partIndex,
  partCount,
  startFrame,
  endFrame,
  totalFrames,
  sampleRate,
}) {
  const manifest = {
    version: 1,
    groupId: String(groupId ?? '').trim(),
    audioFootprint: String(audioFootprint ?? '').trim(),
    fileName: String(fileName ?? '').trim(),
    partIndex: Number(partIndex),
    partCount: Number(partCount),
    startFrame: Number(startFrame),
    endFrame: Number(endFrame),
    totalFrames: Number(totalFrames),
    sampleRate: Number(sampleRate),
  }
  if (
    !isNonEmptyString(manifest.groupId)
    || !isNonEmptyString(manifest.audioFootprint)
    || !isNonEmptyString(manifest.fileName)
    || !Number.isInteger(manifest.partIndex)
    || !Number.isInteger(manifest.partCount)
    || manifest.partIndex < 0
    || manifest.partCount < 1
    || manifest.partIndex >= manifest.partCount
    || !Number.isInteger(manifest.startFrame)
    || !Number.isInteger(manifest.endFrame)
    || !Number.isInteger(manifest.totalFrames)
    || manifest.startFrame < 0
    || manifest.endFrame <= manifest.startFrame
    || manifest.totalFrames < manifest.endFrame
    || !Number.isFinite(manifest.sampleRate)
    || manifest.sampleRate <= 0
  ) throw new RangeError('Source chunk manifest is invalid')
  return manifest
}

export function formatSourceChunkManifest(manifest) {
  const normalized = createSourceChunkManifest(manifest)
  return `${SOURCE_CHUNK_MANIFEST_PREFIX}${JSON.stringify([
    normalized.groupId,
    normalized.audioFootprint,
    normalized.fileName,
    normalized.partIndex,
    normalized.partCount,
    normalized.startFrame,
    normalized.endFrame,
    normalized.totalFrames,
    normalized.sampleRate,
  ])}`
}

export function parseSourceChunkManifest(description) {
  if (typeof description !== 'string') return null
  const start = description.indexOf(SOURCE_CHUNK_MANIFEST_PREFIX)
  if (start < 0) return null
  const encoded = description.slice(start + SOURCE_CHUNK_MANIFEST_PREFIX.length).split(/\r?\n/, 1)[0]
  try {
    const parsed = JSON.parse(encoded)
    if (Array.isArray(parsed) && parsed.length === 9) {
      return createSourceChunkManifest({
        groupId: parsed[0],
        audioFootprint: parsed[1],
        fileName: parsed[2],
        partIndex: parsed[3],
        partCount: parsed[4],
        startFrame: parsed[5],
        endFrame: parsed[6],
        totalFrames: parsed[7],
        sampleRate: parsed[8],
      })
    }
    if (parsed?.version === 1) return createSourceChunkManifest(parsed)
    return null
  } catch {
    return null
  }
}

export function parseLegacySourceChunkName(displayName) {
  if (typeof displayName !== 'string') return null
  const match = displayName.trim().match(/^(.*?)\s*·\s*PART\s+(\d+)\s*\/\s*(\d+)\s*$/i)
  if (!match) return null
  const partIndex = Number(match[2]) - 1
  const partCount = Number(match[3])
  if (!match[1].trim() || !Number.isInteger(partIndex) || !Number.isInteger(partCount)
    || partIndex < 0 || partCount < 1 || partIndex >= partCount) return null
  return { fileName: match[1].trim(), partIndex, partCount }
}

function sameManifestTrack(left, right) {
  return left.groupId === right.groupId
    && left.audioFootprint === right.audioFootprint
    && left.fileName === right.fileName
    && left.partCount === right.partCount
    && left.totalFrames === right.totalFrames
    && left.sampleRate === right.sampleRate
}

function hashLegacyIdentity(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function legacyManifests(entries) {
  const parsed = entries.map((entry) => ({ entry, part: parseLegacySourceChunkName(entry.displayName) }))
    .filter(({ part }) => part !== null)
  const buckets = new Map()
  parsed.forEach(({ entry, part }) => {
    const key = `${part.fileName}\u0000${part.partCount}`
    const bucket = buckets.get(key) ?? []
    bucket.push({ entry, part })
    buckets.set(key, bucket)
  })
  const result = []
  buckets.forEach((bucket, key) => {
    const samplesByPart = new Map()
    bucket.forEach(({ entry, part }) => {
      if (!samplesByPart.has(part.partIndex)) samplesByPart.set(part.partIndex, entry)
    })
    if (samplesByPart.size !== bucket[0].part.partCount) return
    const orderedSamples = Array.from({ length: bucket[0].part.partCount }, (_, index) => samplesByPart.get(index))
    if (orderedSamples.some((entry) => !entry || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0)) return
    const sampleRate = 48_000
    const boundaries = [0]
    orderedSamples.forEach((entry) => boundaries.push(
      boundaries.at(-1) + Math.max(1, Math.round(entry.durationSeconds * sampleRate)),
    ))
    const sampleIdentity = orderedSamples.map((entry) => entry.sampleId).join('|')
    const groupId = `legacy-${hashLegacyIdentity(`${key}|${sampleIdentity}`)}`
    const audioFootprint = `legacy-${hashLegacyIdentity(sampleIdentity)}`
    bucket.forEach(({ entry, part }) => {
      result.push({
        entry,
        manifest: createSourceChunkManifest({
          groupId,
          audioFootprint,
          fileName: part.fileName,
          partIndex: part.partIndex,
          partCount: part.partCount,
          startFrame: boundaries[part.partIndex],
          endFrame: boundaries[part.partIndex + 1],
          totalFrames: boundaries.at(-1),
          sampleRate,
        }),
        legacy: true,
      })
    })
  })
  return result
}

export function reconstructLogicalChunkGroups(entries, { allowSuffixes = false } = {}) {
  const manifested = entries.flatMap((entry) => {
    const manifest = parseSourceChunkManifest(entry.description)
    return manifest ? [{ entry, manifest, legacy: false }] : []
  })
  const manifestRegionIds = new Set(manifested.map(({ entry }) => entry.regionId))
  manifested.push(...legacyManifests(entries.filter((entry) => !manifestRegionIds.has(entry.regionId))))
  const buckets = new Map()
  manifested.forEach((item) => {
    const key = item.manifest.groupId
    const bucket = buckets.get(key) ?? []
    bucket.push(item)
    buckets.set(key, bucket)
  })
  const groups = []
  buckets.forEach((bucket) => {
    const reference = bucket[0]?.manifest
    if (!reference || bucket.some(({ manifest }) => !sameManifestTrack(reference, manifest))) return
    const knownParts = new Map()
    for (const { manifest } of bucket) {
      const known = knownParts.get(manifest.partIndex)
      if (known && (known.startFrame !== manifest.startFrame || known.endFrame !== manifest.endFrame)) return
      knownParts.set(manifest.partIndex, manifest)
    }
    const sorted = bucket.slice().sort((left, right) =>
      left.entry.positionTicks - right.entry.positionTicks
      || left.manifest.partIndex - right.manifest.partIndex
      || left.entry.regionId.localeCompare(right.entry.regionId))
    let run = []
    const finishRun = () => {
      if (run.length === 0) return
      const first = run[0]
      const last = run.at(-1)
      const consecutive = run.every((item, index) =>
        item.manifest.partIndex === first.manifest.partIndex + index
        && (index === 0 || item.entry.positionTicks
          === run[index - 1].entry.positionTicks
            + (run[index - 1].entry.logicalDurationTicks ?? run[index - 1].entry.durationTicks)))
      const completeStart = first.manifest.partIndex === 0 && first.manifest.startFrame === 0
      const completeEnd = last.manifest.partIndex === reference.partCount - 1
        && last.manifest.endFrame === reference.totalFrames
      if (consecutive && completeEnd && (allowSuffixes || completeStart)
        && (allowSuffixes || run.length === reference.partCount)) {
        groups.push({
          groupId: reference.groupId,
          audioFootprint: reference.audioFootprint,
          fileName: reference.fileName,
          partCount: reference.partCount,
          totalFrames: reference.totalFrames,
          sampleRate: reference.sampleRate,
          durationSeconds: reference.totalFrames / reference.sampleRate,
          startPartIndex: first.manifest.partIndex,
          complete: completeStart && run.length === reference.partCount,
          legacy: run.some((item) => item.legacy),
          regions: run.map((item) => ({ ...item.entry, manifest: item.manifest })),
        })
      }
      run = []
    }
    sorted.forEach((item) => {
      const previous = run.at(-1)
      if (previous && (
        item.manifest.partIndex !== previous.manifest.partIndex + 1
        || item.entry.positionTicks !== previous.entry.positionTicks
          + (previous.entry.logicalDurationTicks ?? previous.entry.durationTicks)
      )) finishRun()
      run.push(item)
    })
    finishRun()
  })
  return groups.sort((left, right) =>
    left.regions[0].positionTicks - right.regions[0].positionTicks
    || left.startPartIndex - right.startPartIndex
    || left.regions[0].regionId.localeCompare(right.regions[0].regionId))
}

export function logicalChunkDuration(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) return 0
  const reference = manifests[0]
  if (manifests.some((manifest) => !sameManifestTrack(reference, manifest))) {
    throw new Error('Chunk manifests do not describe one logical track')
  }
  return reference.totalFrames / reference.sampleRate
}

export function resolveCueToSourceChunk(manifests, cuePosition) {
  if (!Number.isFinite(cuePosition) || cuePosition < 0 || cuePosition >= 1) {
    throw new RangeError('Cue position must be in [0, 1)')
  }
  const ordered = manifests.slice().sort((left, right) => left.partIndex - right.partIndex)
  if (ordered.length === 0) throw new Error('Logical track has no chunks')
  const reference = ordered[0]
  if (ordered.length !== reference.partCount
    || ordered.some((manifest, index) => manifest.partIndex !== index || !sameManifestTrack(reference, manifest))) {
    throw new Error('Logical track chunk set is incomplete or ambiguous')
  }
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index].startFrame !== (index === 0 ? 0 : ordered[index - 1].endFrame)) {
      throw new Error('Logical track chunk boundaries are not contiguous')
    }
  }
  if (ordered.at(-1).endFrame !== reference.totalFrames) {
    throw new Error('Logical track final boundary is incomplete')
  }
  const absoluteFrame = Math.min(
    reference.totalFrames - 1,
    Math.max(0, Math.round(cuePosition * reference.totalFrames)),
  )
  const manifest = ordered.find((candidate) =>
    absoluteFrame >= candidate.startFrame && absoluteFrame < candidate.endFrame)
  if (!manifest) throw new Error('Cue does not resolve to a source chunk')
  return {
    manifest,
    absoluteFrame,
    localFrame: absoluteFrame - manifest.startFrame,
    localPosition: (absoluteFrame - manifest.startFrame) / (manifest.endFrame - manifest.startFrame),
  }
}

export function planSourceChunkSuffix({ chunks, cuePosition, targetPositionTicks }) {
  if (!Number.isSafeInteger(targetPositionTicks) || targetPositionTicks < 0) {
    throw new RangeError('Target position must be a non-negative safe integer')
  }
  const manifests = chunks.map((chunk) => chunk.manifest)
  const resolved = resolveCueToSourceChunk(manifests, cuePosition)
  const ordered = chunks.slice().sort((left, right) => left.manifest.partIndex - right.manifest.partIndex)
  const startIndex = ordered.findIndex((chunk) => chunk.manifest.partIndex === resolved.manifest.partIndex)
  let positionTicks = targetPositionTicks
  const suffix = ordered.slice(startIndex).map((chunk, index) => {
    if (!Number.isSafeInteger(chunk.durationTicks) || chunk.durationTicks < 1) {
      throw new RangeError('Chunk duration must be a positive safe integer')
    }
    const collectionOffsetTicks = index === 0
      ? Math.min(chunk.durationTicks - 1, Math.max(0, Math.round(resolved.localPosition * chunk.durationTicks)))
      : 0
    const durationTicks = chunk.durationTicks - collectionOffsetTicks
    const planned = {
      manifest: chunk.manifest,
      positionTicks,
      durationTicks,
      collectionOffsetTicks,
      automationTerminalTicks: chunk.durationTicks,
      includeFadeIn: index === 0,
      includeFadeOut: index === ordered.length - startIndex - 1,
    }
    positionTicks += durationTicks
    return planned
  })
  return {
    resolved,
    chunks: suffix,
    totalRemainingDurationTicks: positionTicks - targetPositionTicks,
  }
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
  const order = ['decoding', 'uploading', 'chunks-ready', 'ready']
  if (next === 'failed' || next === 'cancelled') return next
  if (current === 'failed' || current === 'cancelled') return current
  if (order.indexOf(next) < order.indexOf(current)) {
    throw new Error(`Upload phase cannot move from ${current} to ${next}`)
  }
  return next
}
