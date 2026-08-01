export const CUE_POINT_SLOT_COUNT = 5

export function emptyCuePointSlots() {
  return [null, null, null, null, null]
}

export function validCuePosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1
}

function validPoints(value) {
  return Array.isArray(value)
    && value.length === CUE_POINT_SLOT_COUNT
    && value.every((point) => point === null || validCuePosition(point))
}

export function parseCueRecordV1(value, audioFootprint) {
  if (
    !value
    || typeof value !== 'object'
    || value.version !== 1
    || value.audioFootprint !== audioFootprint
    || !validPoints(value.points)
  ) return null
  return [...value.points]
}

export function parseCueRecordV2(value, audioFootprint) {
  if (
    !value
    || typeof value !== 'object'
    || value.version !== 2
    || value.audioFootprint !== audioFootprint
    || !validPoints(value.points)
    || !Number.isFinite(value.updatedAt)
    || value.updatedAt < 0
  ) return null
  return {
    version: 2,
    audioFootprint,
    points: [...value.points],
    updatedAt: value.updatedAt,
  }
}

export function reconcileLegacyCuePoints(sessionPoints, authoritativePoints) {
  const validSessionPoints = validPoints(sessionPoints)
    ? [...sessionPoints]
    : emptyCuePointSlots()
  const validAuthoritative = Array.isArray(authoritativePoints)
    ? authoritativePoints.filter(validCuePosition).slice(0, CUE_POINT_SLOT_COUNT)
    : []
  if (validAuthoritative.length === 0) return validSessionPoints

  const reconciled = emptyCuePointSlots()
  const remaining = [...validAuthoritative]
  validSessionPoints.forEach((storedPoint, slot) => {
    if (storedPoint === null) return
    const closest = remaining
      .map((point, index) => ({ difference: Math.abs(point - storedPoint), index }))
      .sort((left, right) => left.difference - right.difference)[0]
    if (!closest || closest.difference >= 0.000_5) return
    reconciled[slot] = remaining.splice(closest.index, 1)[0]
  })
  remaining.forEach((point) => {
    const emptySlot = reconciled.findIndex((candidate) => candidate === null)
    if (emptySlot >= 0) reconciled[emptySlot] = point
  })
  return reconciled
}

export async function loadCuePointMetadata({
  audioFootprint,
  authoritativePoints = [],
  readPersistent,
  readSession,
  writePersistent,
  writeSession,
  removeSession,
  now = Date.now,
}) {
  let sessionPoints = emptyCuePointSlots()
  try {
    sessionPoints = parseCueRecordV1(await readSession(), audioFootprint)
      ?? emptyCuePointSlots()
  } catch {
    // A broken session record is equivalent to no legacy ordering.
  }

  try {
    const persistent = parseCueRecordV2(await readPersistent(), audioFootprint)
    if (persistent) {
      return { points: persistent.points, persistence: 'indexeddb', migrated: false }
    }
    const points = reconcileLegacyCuePoints(sessionPoints, authoritativePoints)
    const record = {
      version: 2,
      audioFootprint,
      points,
      updatedAt: now(),
    }
    await writePersistent(record)
    await removeSession()
    return { points, persistence: 'indexeddb', migrated: true }
  } catch (error) {
    const points = reconcileLegacyCuePoints(sessionPoints, authoritativePoints)
    await writeSession({ version: 1, audioFootprint, points }).catch(() => undefined)
    return { points, persistence: 'session', migrated: false, error }
  }
}

export async function saveCuePointMetadata({
  audioFootprint,
  points,
  writePersistent,
  writeSession,
  now = Date.now,
}) {
  if (!validPoints(points)) throw new RangeError('Cue points are invalid')
  const record = {
    version: 2,
    audioFootprint,
    points: [...points],
    updatedAt: now(),
  }
  try {
    await writePersistent(record)
    return { persistence: 'indexeddb' }
  } catch (error) {
    await writeSession({
      version: 1,
      audioFootprint,
      points: [...points],
    })
    return { persistence: 'session', error }
  }
}
