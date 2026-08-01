export const TRANSPORT_CHANNEL = 'magic-deck.transport.v2'
export const TRANSPORT_RESPONSE_MAX_AGE_MS = 2_000
export const TRANSPORT_REQUEST_TIMEOUT_MS = 1_500
export const NEXUS_DELIVERY_GUARD_MS = 750
export const TRANSPORT_TICKS_PER_BEAT = 3_840

export function normalizeProjectId(value) {
  if (typeof value !== 'string') return null
  try {
    const normalized = decodeURIComponent(value).trim().replace(/^projects\//, '')
    return /^[a-zA-Z0-9_-]+$/.test(normalized) ? normalized : null
  } catch {
    return null
  }
}

export function projectIdFromUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value)
    const queryProject = normalizeProjectId(url.searchParams.get('project'))
    if (queryProject) return queryProject

    const parts = url.pathname.split('/').filter(Boolean)
    const projectsIndex = parts.findIndex((part) => part === 'projects')
    if (projectsIndex >= 0) return normalizeProjectId(parts[projectsIndex + 1])
    if (parts[0] === 'studio' && parts.length > 1) return normalizeProjectId(parts[1])
  } catch {
    return null
  }
  return null
}

function validCounterPart(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null
}

export function parseTransportPosition(raw, capturedAt = Date.now()) {
  if (typeof raw !== 'string') return null
  const value = raw.replace(/\u00a0/g, ' ').trim()
  if (value === '') return null

  const labelledBar = value.match(/\bbar\s*[:#]?\s*0*(\d+)\b/i)
  if (labelledBar) {
    const bar = validCounterPart(labelledBar[1], 1)
    const beatMatch = value.match(/\bbeat\s*[:#]?\s*0*(\d+)\b/i)
    const tickMatch = value.match(/\btick\s*[:#]?\s*0*(\d+)\b/i)
    const beat = beatMatch ? validCounterPart(beatMatch[1], 1, 4) : undefined
    const tick = tickMatch
      ? validCounterPart(tickMatch[1], 0, TRANSPORT_TICKS_PER_BEAT - 1)
      : undefined
    if (bar === null || (beatMatch && beat === null) || (tickMatch && tick === null)) return null
    if (tick !== undefined && beat === undefined) return null
    return {
      bar,
      ...(beat === undefined ? {} : { beat }),
      ...(tick === undefined ? {} : { tick }),
      precision: tick === undefined ? (beat === undefined ? 'bar' : 'beat') : 'tick',
      capturedAt,
    }
  }

  const counter = value.match(
    /^0*(\d+)\s*(?:[.:|/]\s*|\s+)0*(\d+)(?:\s*(?:[.:|/]\s*|\s+)0*(\d+))?$/,
  )
  if (!counter) return null
  const bar = validCounterPart(counter[1], 1)
  const beat = validCounterPart(counter[2], 1, 4)
  const tick = counter[3] === undefined
    ? undefined
    : validCounterPart(counter[3], 0, TRANSPORT_TICKS_PER_BEAT - 1)
  if (bar === null || beat === null || tick === null) return null
  return {
    bar,
    beat,
    ...(tick === undefined ? {} : { tick }),
    precision: tick === undefined ? 'beat' : 'tick',
    capturedAt,
  }
}

export function matchProjectTabs(tabs, projectId) {
  const normalizedProjectId = normalizeProjectId(projectId)
  if (!normalizedProjectId) return { ok: false, reason: 'invalid-project-id' }

  const matches = tabs.filter((tab) =>
    typeof tab?.url === 'string'
    && projectIdFromUrl(tab.url) === normalizedProjectId)

  if (matches.length === 0) return { ok: false, reason: 'project-tab-not-found' }
  if (matches.length > 1) return { ok: false, reason: 'multiple-project-tabs' }
  if (!Number.isInteger(matches[0].id)) return { ok: false, reason: 'project-tab-has-no-id' }
  return { ok: true, tab: matches[0] }
}

export function validateTransportResponse(response, expected, now = Date.now()) {
  if (!response || typeof response !== 'object') return { ok: false, reason: 'invalid-response' }
  if (response.channel !== TRANSPORT_CHANNEL || response.type !== 'response') {
    return { ok: false, reason: 'invalid-response-type' }
  }
  if (response.requestId !== expected.requestId) return { ok: false, reason: 'request-mismatch' }
  if (response.projectId !== expected.projectId) return { ok: false, reason: 'project-mismatch' }
  if (response.ok !== true) {
    return {
      ok: false,
      reason: typeof response.reason === 'string' ? response.reason : 'capture-failed',
    }
  }
  if (
    !Number.isFinite(response.capturedAt)
    || response.capturedAt > now + 250
    || now - response.capturedAt > TRANSPORT_RESPONSE_MAX_AGE_MS
  ) {
    return { ok: false, reason: 'stale-response' }
  }
  const position = validateTransportPosition(response, response.capturedAt)
  if (!position) return { ok: false, reason: 'invalid-position' }
  return {
    ok: true,
    position,
    raw: typeof response.raw === 'string' ? response.raw : undefined,
  }
}

export function validateTransportPosition(
  value,
  capturedAt = Date.now(),
  ticksPerBeat = TRANSPORT_TICKS_PER_BEAT,
) {
  if (!value || typeof value !== 'object') return null
  const bar = validCounterPart(value.bar, 1)
  const beat = value.beat === undefined ? undefined : validCounterPart(value.beat, 1, 4)
  const tickMaximum = Number.isSafeInteger(ticksPerBeat) && ticksPerBeat > 0
    ? ticksPerBeat - 1
    : Number.MAX_SAFE_INTEGER
  const tick = value.tick === undefined ? undefined : validCounterPart(value.tick, 0, tickMaximum)
  if (bar === null || beat === null || tick === null || (tick !== undefined && beat === undefined)) {
    return null
  }
  const precision = tick !== undefined ? 'tick' : beat !== undefined ? 'beat' : 'bar'
  if (value.precision !== undefined && value.precision !== precision) return null
  return {
    bar,
    ...(beat === undefined ? {} : { beat }),
    ...(tick === undefined ? {} : { tick }),
    precision,
    capturedAt,
  }
}

export function mergeTransportPositions(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return null
  const validated = positions.map((position) =>
    validateTransportPosition(position, position?.capturedAt),
  )
  if (validated.some((position) => position === null)) return null
  const bars = new Set(validated.map((position) => position.bar))
  const beats = new Set(
    validated.flatMap((position) => position.beat === undefined ? [] : [position.beat]),
  )
  const ticks = new Set(
    validated.flatMap((position) => position.tick === undefined ? [] : [position.tick]),
  )
  if (bars.size !== 1 || beats.size > 1 || ticks.size > 1) return null
  return validated.reduce((mostPrecise, position) => {
    const rank = { bar: 0, beat: 1, tick: 2 }
    return rank[position.precision] > rank[mostPrecise.precision] ? position : mostPrecise
  })
}

export function barToPositionTicks(bar, ticksPerBar) {
  if (!Number.isSafeInteger(bar) || bar < 1) throw new RangeError('Bar must be a one-based whole number')
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar <= 0) {
    throw new RangeError('Ticks per bar must be a positive whole number')
  }
  const positionTicks = (bar - 1) * ticksPerBar
  if (!Number.isSafeInteger(positionTicks)) throw new RangeError('Bar position exceeds the safe tick range')
  return positionTicks
}

function checkedAdd(left, right, message = 'Tick calculation exceeds the safe range') {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new RangeError(message)
  return result
}

export function transportPositionToTicks(position, ticksPerBeat, ticksPerBar) {
  const validated = validateTransportPosition(position, position?.capturedAt, ticksPerBeat)
  if (!validated) throw new RangeError('Transport position is invalid')
  if (!Number.isSafeInteger(ticksPerBeat) || ticksPerBeat <= 0) {
    throw new RangeError('Ticks per beat must be a positive whole number')
  }
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar !== ticksPerBeat * 4) {
    throw new RangeError('Ticks per bar must equal four beats')
  }
  const barStart = barToPositionTicks(validated.bar, ticksPerBar)
  if (validated.precision === 'bar') {
    return checkedAdd(barStart, ticksPerBar - 1)
  }
  const beatStart = checkedAdd(barStart, (validated.beat - 1) * ticksPerBeat)
  if (validated.precision === 'beat') {
    return checkedAdd(beatStart, ticksPerBeat - 1)
  }
  return checkedAdd(beatStart, validated.tick)
}

export function guardedTransportTicks(
  position,
  bpm,
  now,
  ticksPerBeat,
  ticksPerBar,
  deliveryGuardMs = NEXUS_DELIVERY_GUARD_MS,
) {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) {
    throw new RangeError('BPM must be between 40 and 240')
  }
  if (!Number.isFinite(now) || !Number.isFinite(position?.capturedAt)) {
    throw new RangeError('Transport timestamps must be finite')
  }
  const elapsedMs = Math.max(0, now - position.capturedAt) + deliveryGuardMs
  const elapsedTicks = Math.ceil(elapsedMs * bpm * ticksPerBeat / 60_000)
  return checkedAdd(
    transportPositionToTicks(position, ticksPerBeat, ticksPerBar),
    elapsedTicks,
  )
}

export function resolveLaunchTick(
  quantization,
  guardedTicks,
  ticksPerBar,
  exactBar,
) {
  if (!Number.isSafeInteger(guardedTicks) || guardedTicks < 0) {
    throw new RangeError('Guarded transport ticks must be a non-negative whole number')
  }
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar <= 0) {
    throw new RangeError('Ticks per bar must be a positive whole number')
  }
  if (quantization === 'exact-bar') {
    if (!Number.isSafeInteger(exactBar) || exactBar < 1) {
      throw new RangeError('Exact launch bar must be a one-based whole number')
    }
    const target = barToPositionTicks(exactBar, ticksPerBar)
    return target > guardedTicks ? target : null
  }
  const quantum = quantization === 'next-phrase'
    ? checkedAdd(ticksPerBar, ticksPerBar * 3)
    : quantization === 'next-bar'
      ? ticksPerBar
      : null
  if (quantum === null) throw new RangeError('Unknown launch quantization')
  const target = (Math.floor(guardedTicks / quantum) + 1) * quantum
  if (!Number.isSafeInteger(target)) throw new RangeError('Launch boundary exceeds the safe tick range')
  return target
}

export function moveLaunchPosition(
  positionTicks,
  action,
  ticksPerBeat,
  ticksPerBar,
) {
  if (!Number.isSafeInteger(positionTicks) || positionTicks < 0) {
    throw new RangeError('Remembered launch ticks must be a non-negative whole number')
  }
  if (!Number.isSafeInteger(ticksPerBeat) || ticksPerBeat <= 0) {
    throw new RangeError('Ticks per beat must be a positive whole number')
  }
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar !== ticksPerBeat * 4) {
    throw new RangeError('Ticks per bar must equal four beats')
  }
  const delta = {
    'previous-beat': -ticksPerBeat,
    'next-beat': ticksPerBeat,
    'previous-bar': -ticksPerBar,
    'next-bar': ticksPerBar,
    'previous-four-bars': -ticksPerBar * 4,
    'next-four-bars': ticksPerBar * 4,
  }[action]
  if (delta === undefined) throw new RangeError('Unknown launch position action')
  const target = checkedAdd(positionTicks, delta, 'Launch position exceeds the safe tick range')
  if (target < 0) throw new RangeError('Launch position cannot move before bar 1')
  return target
}

export function composeLaunchPositionAction(direction, step) {
  const action = {
    previous: {
      beat: 'previous-beat',
      bar: 'previous-bar',
      'four-bars': 'previous-four-bars',
    },
    next: {
      beat: 'next-beat',
      bar: 'next-bar',
      'four-bars': 'next-four-bars',
    },
  }[direction]?.[step]
  if (action === undefined) throw new RangeError('Unknown launch direction or step')
  return action
}

export function tickToBar(tick, ticksPerBar) {
  if (!Number.isSafeInteger(tick) || tick < 0 || !Number.isSafeInteger(ticksPerBar) || ticksPerBar <= 0) {
    throw new RangeError('Tick and bar size must be safe non-negative values')
  }
  return Math.floor(tick / ticksPerBar) + 1
}

export function planRegionLaunch(fullDurationTicks, targetTicks) {
  if (!Number.isSafeInteger(fullDurationTicks) || fullDurationTicks <= 0) {
    throw new RangeError('Full region duration must be positive')
  }
  if (!Number.isSafeInteger(targetTicks) || targetTicks < 0) {
    throw new RangeError('Launch tick must be non-negative')
  }
  return { kind: 'launch', positionTicks: targetTicks, durationTicks: fullDurationTicks, isEnabled: true }
}

export function planRegionCancel(regionStartTicks, guardedTicks) {
  if (!Number.isSafeInteger(regionStartTicks) || !Number.isSafeInteger(guardedTicks)) {
    throw new RangeError('Region and transport ticks must be whole numbers')
  }
  return regionStartTicks > guardedTicks
    ? { kind: 'cancel', isEnabled: false }
    : { kind: 'refuse', reason: 'launch-boundary-reached' }
}

export function planRegionStop(
  regionStartTicks,
  currentDurationTicks,
  fullDurationTicks,
  isEnabled,
  guardedTicks,
  targetTicks,
) {
  const values = [regionStartTicks, currentDurationTicks, fullDurationTicks, guardedTicks, targetTicks]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError('Region stop values must be non-negative whole numbers')
  }
  if (!isEnabled) return { kind: 'noop', reason: 'region-disabled' }
  if (regionStartTicks > guardedTicks) return { kind: 'cancel', isEnabled: false }
  const earliestExistingEnd = checkedAdd(
    regionStartTicks,
    Math.min(currentDurationTicks, fullDurationTicks),
  )
  if (earliestExistingEnd <= targetTicks) {
    return { kind: 'noop', reason: 'natural-end-first' }
  }
  return {
    kind: 'stop',
    durationTicks: Math.max(0, targetTicks - regionStartTicks),
  }
}
