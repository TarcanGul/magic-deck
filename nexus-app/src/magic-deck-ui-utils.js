export function magicRestingStatus(content, detail = '') {
  if (content === 'empty') return { state: 'idle', label: 'IDLE' }
  const prefix = content === 'generated' ? 'GENERATED' : 'RESTORED'
  return {
    state: 'done',
    label: detail ? `${prefix} · ${detail}` : prefix,
  }
}

export function createMagicStatusController(render, timers = globalThis) {
  let restingStatus = magicRestingStatus('empty')
  let resetTimer = null

  const cancelReset = () => {
    if (resetTimer === null) return
    timers.clearTimeout(resetTimer)
    resetTimer = null
  }

  return {
    show(status) {
      cancelReset()
      render(status)
    },
    setResting(content, detail = '') {
      cancelReset()
      restingStatus = magicRestingStatus(content, detail)
      render(restingStatus)
    },
    showTemporary(status, durationMs) {
      cancelReset()
      render(status)
      resetTimer = timers.setTimeout(() => {
        resetTimer = null
        render(restingStatus)
      }, durationMs)
    },
    clear() {
      cancelReset()
      restingStatus = magicRestingStatus('empty')
      render(restingStatus)
    },
    getResting() {
      return restingStatus
    },
  }
}

export function isDeckFxAvailable({
  projectConnected,
  hasProjectDocument,
  deckIndex,
  pendingCount,
  activeKind,
  hasPlayableMagicContent,
  activeFxDeckIndex,
  hasActiveLibrary,
}) {
  if (!projectConnected || !hasProjectDocument) return false
  if (activeFxDeckIndex === deckIndex || hasActiveLibrary) return false
  if (pendingCount === 0) return true
  return deckIndex === 2
    && activeKind === 'generating'
    && hasPlayableMagicContent
}
