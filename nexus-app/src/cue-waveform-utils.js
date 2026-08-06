export const CUE_ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64]

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

export function createCueViewport(zoomLevel = 1, center = 0.5) {
  if (!CUE_ZOOM_LEVELS.includes(zoomLevel)) {
    throw new RangeError('Cue zoom level must be one of the supported levels')
  }
  const span = 1 / zoomLevel
  const start = clamp(center - span / 2, 0, 1 - span)
  return { zoomLevel, start, end: start + span }
}

export function zoomCueViewport(viewport, zoomLevel, anchorPosition, anchorRatio = 0.5) {
  if (!CUE_ZOOM_LEVELS.includes(zoomLevel)) {
    throw new RangeError('Cue zoom level must be one of the supported levels')
  }
  if (![anchorPosition, anchorRatio].every(Number.isFinite)) {
    throw new RangeError('Cue zoom anchor must be finite')
  }
  const span = 1 / zoomLevel
  const start = clamp(
    clamp(anchorPosition, 0, 1) - clamp(anchorRatio, 0, 1) * span,
    0,
    1 - span,
  )
  return { zoomLevel, start, end: start + span }
}

export function panCueViewport(viewport, delta) {
  if (!Number.isFinite(delta)) throw new RangeError('Cue pan delta must be finite')
  const span = 1 / viewport.zoomLevel
  const start = clamp(viewport.start + delta, 0, 1 - span)
  return { zoomLevel: viewport.zoomLevel, start, end: start + span }
}

export function cuePositionFromPointer(pointerX, width, viewport) {
  if (!Number.isFinite(pointerX) || !Number.isFinite(width) || width <= 0) {
    throw new RangeError('Cue pointer coordinates must be finite and width must be positive')
  }
  const ratio = clamp(pointerX / width, 0, 1)
  return clamp(viewport.start + ratio * (viewport.end - viewport.start), 0, 1)
}

export function clampCueTicks(positionTicks, durationTicks) {
  requirePositiveInteger(durationTicks, 'Cue duration ticks')
  if (!Number.isFinite(positionTicks)) throw new RangeError('Cue position ticks must be finite')
  return clamp(Math.round(positionTicks), 0, durationTicks - 1)
}

export function normalizedCuePositionToTicks(position, durationTicks) {
  requirePositiveInteger(durationTicks, 'Cue duration ticks')
  if (!Number.isFinite(position)) throw new RangeError('Normalized cue position must be finite')
  return clampCueTicks(position * durationTicks, durationTicks)
}

export function cueTicksToNormalizedPosition(positionTicks, durationTicks) {
  return clampCueTicks(positionTicks, durationTicks) / durationTicks
}

export function formatCueTickPosition(
  positionTicks,
  durationTicks,
  ticksPerBar,
  ticksPerBeat,
  durationSeconds,
) {
  requirePositiveInteger(ticksPerBar, 'Ticks per bar')
  requirePositiveInteger(ticksPerBeat, 'Ticks per beat')
  const ticks = clampCueTicks(positionTicks, durationTicks)
  const bar = Math.floor(ticks / ticksPerBar) + 1
  const withinBar = ticks % ticksPerBar
  const beat = Math.floor(withinBar / ticksPerBeat) + 1
  const tick = withinBar % ticksPerBeat
  const totalMilliseconds = Number.isFinite(durationSeconds) && durationSeconds >= 0
    ? Math.round(durationSeconds * 1000 * ticks / durationTicks)
    : 0
  const minutes = Math.floor(totalMilliseconds / 60_000)
  const seconds = Math.floor(totalMilliseconds % 60_000 / 1_000)
  const milliseconds = totalMilliseconds % 1_000
  return `B${bar}.${beat}.${tick} · ${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`
}
