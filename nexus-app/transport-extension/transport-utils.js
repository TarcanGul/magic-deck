export const TRANSPORT_CHANNEL = 'magic-deck.transport.v1'
export const TRANSPORT_RESPONSE_MAX_AGE_MS = 2_000
export const TRANSPORT_REQUEST_TIMEOUT_MS = 1_500

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

export function parseTransportBar(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.replace(/\u00a0/g, ' ').trim()
  if (value === '') return null

  const labelled = value.match(/\bbar\s*[:#]?\s*(\d+)\b/i)
  const counter = value.match(/^0*(\d+)\s*(?:[.:|/]\s*|\s+)\d+(?:\s*(?:[.:|/]\s*|\s+)\d+)?$/)
  const match = labelled ?? counter
  if (!match) return null

  const bar = Number(match[1])
  return Number.isSafeInteger(bar) && bar >= 1 ? bar : null
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
  if (!Number.isSafeInteger(response.bar) || response.bar < 1) {
    return { ok: false, reason: 'invalid-bar' }
  }
  if (
    !Number.isFinite(response.capturedAt)
    || response.capturedAt > now + 250
    || now - response.capturedAt > TRANSPORT_RESPONSE_MAX_AGE_MS
  ) {
    return { ok: false, reason: 'stale-response' }
  }
  return {
    ok: true,
    bar: response.bar,
    raw: typeof response.raw === 'string' ? response.raw : undefined,
    capturedAt: response.capturedAt,
  }
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
