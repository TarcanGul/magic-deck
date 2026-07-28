import {
  TRANSPORT_CHANNEL,
  matchProjectTabs,
  normalizeProjectId,
} from './transport-utils.js'

function failure(request, reason) {
  return {
    channel: TRANSPORT_CHANNEL,
    type: 'response',
    requestId: request.requestId,
    projectId: request.projectId,
    ok: false,
    capturedAt: Date.now(),
    reason,
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (
    request?.channel !== TRANSPORT_CHANNEL
    || request?.type !== 'request'
    || sender.tab?.url?.startsWith('http://127.0.0.1:5173/') !== true
  ) return false

  void (async () => {
    const projectId = normalizeProjectId(request.projectId)
    if (
      !projectId
      || projectId !== request.projectId
      || !Number.isSafeInteger(request.deckIndex)
      || request.deckIndex < 0
      || request.deckIndex > 2
    ) {
      sendResponse(failure(request, 'invalid-request'))
      return
    }

    const tabs = await chrome.tabs.query({ url: 'https://beta.audiotool.com/*' })
    const match = matchProjectTabs(tabs, projectId)
    if (!match.ok) {
      sendResponse(failure(request, match.reason))
      return
    }

    try {
      const capture = await chrome.tabs.sendMessage(match.tab.id, {
        channel: TRANSPORT_CHANNEL,
        type: 'capture',
        projectId,
      })
      if (
        !capture
        || capture.channel !== TRANSPORT_CHANNEL
        || capture.type !== 'capture-response'
        || capture.projectId !== projectId
        || capture.ok !== true
      ) {
        sendResponse(failure(request, capture?.reason || 'unreadable-transport-counter'))
        return
      }
      sendResponse({
        channel: TRANSPORT_CHANNEL,
        type: 'response',
        requestId: request.requestId,
        projectId,
        ok: true,
        bar: capture.bar,
        beat: capture.beat,
        tick: capture.tick,
        precision: capture.precision,
        raw: capture.raw,
        capturedAt: capture.capturedAt,
      })
    } catch {
      sendResponse(failure(request, 'studio-content-script-unavailable'))
    }
  })().catch(() => sendResponse(failure(request, 'extension-error')))

  return true
})
