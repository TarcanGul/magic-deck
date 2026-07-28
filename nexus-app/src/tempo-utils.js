export const TEMPO_RANGES = Object.freeze([10, 30, 50])

export function tempoPercentToPlaybackRate(percent) {
  if (!Number.isFinite(percent) || percent <= -100) {
    throw new RangeError('Tempo percent must be finite and greater than -100')
  }
  return 1 + percent / 100
}

export function effectiveBpm(sourceBpm, percent) {
  if (!Number.isFinite(sourceBpm) || sourceBpm <= 0) {
    throw new RangeError('Source BPM must be a positive finite number')
  }
  return sourceBpm * tempoPercentToPlaybackRate(percent)
}

export function tempoPercentForBpm(sourceBpm, targetBpm) {
  if (!Number.isFinite(sourceBpm) || sourceBpm <= 0) {
    throw new RangeError('Source BPM must be a positive finite number')
  }
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) {
    throw new RangeError('Target BPM must be a positive finite number')
  }
  return (targetBpm / sourceBpm - 1) * 100
}

export function clampTempoPercent(percent, range) {
  if (!Number.isFinite(percent)) throw new RangeError('Tempo percent must be finite')
  if (!TEMPO_RANGES.includes(range)) throw new RangeError('Unsupported tempo range')
  return Math.max(-range, Math.min(range, percent))
}

export function smallestTempoRange(percent) {
  if (!Number.isFinite(percent)) return null
  const magnitude = Math.abs(percent)
  return TEMPO_RANGES.find((range) => magnitude <= range + 1e-9) ?? null
}

export function mappedDurationTicks(nativeDurationTicks, percent) {
  if (!Number.isFinite(nativeDurationTicks) || nativeDurationTicks <= 0) {
    throw new RangeError('Native duration must be a positive finite tick count')
  }
  return Math.max(1, Math.round(nativeDurationTicks / tempoPercentToPlaybackRate(percent)))
}

export function reconstructTempoPercent(nativeDurationTicks, mappedDurationTicksValue) {
  if (!Number.isFinite(nativeDurationTicks) || nativeDurationTicks <= 0) {
    throw new RangeError('Native duration must be a positive finite tick count')
  }
  if (!Number.isFinite(mappedDurationTicksValue) || mappedDurationTicksValue <= 0) {
    throw new RangeError('Mapped duration must be a positive finite tick count')
  }
  return (nativeDurationTicks / mappedDurationTicksValue - 1) * 100
}
