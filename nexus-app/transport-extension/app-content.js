const CHANNEL = 'magic-deck.transport.v1'

window.addEventListener('message', (event) => {
  const request = event.data
  if (
    event.source !== window
    || event.origin !== window.location.origin
    || request?.channel !== CHANNEL
    || request?.type !== 'request'
  ) return

  chrome.runtime.sendMessage(request)
    .then((response) => {
      if (response?.channel === CHANNEL && response?.type === 'response') {
        window.postMessage(response, window.location.origin)
      }
    })
    .catch(() => {
      window.postMessage({
        channel: CHANNEL,
        type: 'response',
        requestId: request.requestId,
        projectId: request.projectId,
        ok: false,
        capturedAt: Date.now(),
        reason: 'extension-unavailable',
      }, window.location.origin)
    })
})
