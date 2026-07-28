const utilsPromise = import(chrome.runtime.getURL('transport-utils.js'))

function allOpenRoots(root = document) {
  const roots = [root]
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) roots.push(...allOpenRoots(element.shadowRoot))
  }
  return roots
}

function isVisible(element) {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity) !== 0
    && rect.width > 0
    && rect.height > 0
}

function candidateRawValues(element) {
  return [
    element.getAttribute('aria-label'),
    'value' in element ? element.value : null,
    element.textContent,
  ].filter((value) => typeof value === 'string' && value.trim() !== '')
}

async function captureTransport(projectId) {
  const {
    TRANSPORT_CHANNEL,
    mergeTransportPositions,
    parseTransportPosition,
    projectIdFromUrl,
  } = await utilsPromise
  const capturedAt = Date.now()
  if (projectIdFromUrl(window.location.href) !== projectId) {
    return {
      channel: TRANSPORT_CHANNEL,
      type: 'capture-response',
      projectId,
      ok: false,
      capturedAt,
      reason: 'project-mismatch',
    }
  }

  const selectors = [
    '[data-testid*="transport" i]',
    '[data-testid*="playhead" i]',
    '[data-testid*="position" i]',
    '[aria-label*="transport" i]',
    '[aria-label*="playhead" i]',
    '[aria-label*="position" i]',
    '[aria-label*="bar" i]',
    '[class*="transport" i] [class*="counter" i]',
    '[class*="transport" i] [class*="position" i]',
    '[class*="transport" i] [class*="display" i]',
    '[class*="time-display" i]',
  ]
  const parsed = []
  const seenElements = new Set()
  for (const root of allOpenRoots()) {
    for (const element of root.querySelectorAll(selectors.join(','))) {
      if (seenElements.has(element) || !isVisible(element)) continue
      seenElements.add(element)
      for (const raw of candidateRawValues(element)) {
        const position = parseTransportPosition(raw, capturedAt)
        if (position !== null) parsed.push({ position, raw: raw.trim() })
      }
    }
  }

  const position = mergeTransportPositions(parsed.map((candidate) => candidate.position))
  if (!position) {
    return {
      channel: TRANSPORT_CHANNEL,
      type: 'capture-response',
      projectId,
      ok: false,
      capturedAt,
      reason: parsed.length === 0 ? 'unreadable-transport-counter' : 'ambiguous-transport-counter',
    }
  }
  const raw = parsed.find((candidate) =>
    candidate.position.precision === position.precision
    && candidate.position.bar === position.bar
    && candidate.position.beat === position.beat
    && candidate.position.tick === position.tick,
  )?.raw
  return {
    channel: TRANSPORT_CHANNEL,
    type: 'capture-response',
    projectId,
    ok: true,
    bar: position.bar,
    beat: position.beat,
    tick: position.tick,
    precision: position.precision,
    raw,
    capturedAt,
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type !== 'capture' || typeof request.projectId !== 'string') return false
  void captureTransport(request.projectId).then(sendResponse)
  return true
})
