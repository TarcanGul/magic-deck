export function planAudioRegionSplit(region, cutTicks) {
  const {
    positionTicks,
    durationTicks,
    collectionOffsetTicks,
    loopOffsetTicks,
    loopDurationTicks,
  } = region
  const endTicks = positionTicks + durationTicks
  if (
    !Number.isSafeInteger(cutTicks)
    || cutTicks <= positionTicks
    || cutTicks >= endTicks
  ) {
    throw new Error('Cue cut must be strictly inside the audio region')
  }

  const leftDurationTicks = cutTicks - positionTicks
  return {
    leftDurationTicks,
    right: {
      positionTicks: cutTicks,
      durationTicks: endTicks - cutTicks,
      collectionOffsetTicks: collectionOffsetTicks + leftDurationTicks,
      loopOffsetTicks,
      loopDurationTicks,
    },
  }
}

export function buildIndependentAudioRegionCopy(source, overwrites = {}) {
  const regionOverwrites = overwrites.region ?? {}
  return {
    region: {
      positionTicks: regionOverwrites.positionTicks ?? source.region.positionTicks,
      durationTicks: regionOverwrites.durationTicks ?? source.region.durationTicks,
      collectionOffsetTicks:
        regionOverwrites.collectionOffsetTicks ?? source.region.collectionOffsetTicks,
      loopOffsetTicks: regionOverwrites.loopOffsetTicks ?? source.region.loopOffsetTicks,
      loopDurationTicks:
        regionOverwrites.loopDurationTicks ?? source.region.loopDurationTicks,
      isEnabled: regionOverwrites.isEnabled ?? source.region.isEnabled,
      colorIndex: regionOverwrites.colorIndex ?? source.region.colorIndex,
      displayName: regionOverwrites.displayName ?? source.region.displayName,
    },
    track: source.track,
    playbackAutomationCollection: source.playbackAutomationCollection,
    sample: source.sample,
    gain: overwrites.gain ?? source.gain,
    fadeInDurationTicks:
      overwrites.fadeInDurationTicks ?? source.fadeInDurationTicks,
    fadeInSlope: overwrites.fadeInSlope ?? source.fadeInSlope,
    fadeOutDurationTicks:
      overwrites.fadeOutDurationTicks ?? source.fadeOutDurationTicks,
    fadeOutSlope: overwrites.fadeOutSlope ?? source.fadeOutSlope,
    timestretchMode: overwrites.timestretchMode ?? source.timestretchMode,
    pitchShiftSemitones:
      overwrites.pitchShiftSemitones ?? source.pitchShiftSemitones,
  }
}

export function cuePositionsFromSegments(segments) {
  if (segments.length < 2) return []
  const sorted = [...segments].sort((a, b) =>
    a.positionTicks - b.positionTicks || a.id.localeCompare(b.id))
  const startTicks = sorted[0].positionTicks
  const endTicks = sorted.at(-1).positionTicks + sorted.at(-1).durationTicks
  const durationTicks = endTicks - startTicks
  if (durationTicks <= 0) return []

  const positions = []
  let expectedPositionTicks = startTicks + sorted[0].durationTicks
  for (let index = 1; index < sorted.length; index += 1) {
    const segment = sorted[index]
    if (segment.positionTicks !== expectedPositionTicks) return []
    positions.push((segment.positionTicks - startTicks) / durationTicks)
    expectedPositionTicks = segment.positionTicks + segment.durationTicks
  }
  return positions
}

export function planResizedCueOffsets({
  firstCollectionOffsetTicks,
  firstLoopOffsetTicks,
  loopDurationTicks,
  previousContentDurationTicks,
  nextContentDurationTicks,
  nextStartTicks,
}) {
  if (
    previousContentDurationTicks <= 0
    || nextContentDurationTicks <= 0
    || nextStartTicks < 0
  ) throw new Error('Cue offset resize requires positive durations and a non-negative start')
  const scale = (ticks) =>
    Math.round((ticks / previousContentDurationTicks) * nextContentDurationTicks)
  return {
    collectionOffsetTicks: scale(firstCollectionOffsetTicks) + nextStartTicks,
    loopOffsetTicks: scale(firstLoopOffsetTicks),
    loopDurationTicks: scale(loopDurationTicks),
  }
}

export function cuePositionForBar(bar, ticksPerBar, fullDurationTicks) {
  if (!Number.isSafeInteger(bar) || bar < 1) {
    throw new RangeError('Cue bar must be a one-based whole number')
  }
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar <= 0) {
    throw new RangeError('Ticks per bar must be a positive whole number')
  }
  if (!Number.isSafeInteger(fullDurationTicks) || fullDurationTicks <= 0) {
    throw new RangeError('Track duration must be a positive whole number')
  }
  const cueOffsetTicks = (bar - 1) * ticksPerBar
  if (!Number.isSafeInteger(cueOffsetTicks)) {
    throw new RangeError('Cue bar exceeds the safe tick range')
  }
  if (cueOffsetTicks >= fullDurationTicks) {
    throw new RangeError('Cue bar must start strictly before the track end')
  }
  return cueOffsetTicks / fullDurationTicks
}

export function cueBarForPosition(position, ticksPerBar, fullDurationTicks) {
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position >= 1) {
    throw new RangeError('Cue position must be a finite number in [0, 1)')
  }
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar <= 0) {
    throw new RangeError('Ticks per bar must be a positive whole number')
  }
  if (!Number.isSafeInteger(fullDurationTicks) || fullDurationTicks <= 0) {
    throw new RangeError('Track duration must be a positive whole number')
  }
  return Math.floor((position * fullDurationTicks) / ticksPerBar) + 1
}

export function planLegacyCueChainCollapse(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new RangeError('A legacy cue chain is required')
  }
  const sorted = [...segments].sort((left, right) =>
    left.positionTicks - right.positionTicks || left.id.localeCompare(right.id))
  let endTicks = sorted[0].positionTicks
  sorted.forEach((segment) => {
    if (
      typeof segment.id !== 'string'
      || !Number.isSafeInteger(segment.positionTicks)
      || !Number.isSafeInteger(segment.durationTicks)
      || segment.durationTicks <= 0
      || segment.positionTicks !== endTicks
    ) throw new RangeError('Legacy cue regions must form a contiguous positive chain')
    endTicks += segment.durationTicks
    if (!Number.isSafeInteger(endTicks)) throw new RangeError('Legacy cue chain exceeds safe ticks')
  })
  return {
    keepId: sorted[0].id,
    durationTicks: endTicks - sorted[0].positionTicks,
    collapsedRegion: {
      ...sorted[0],
      durationTicks: endTicks - sorted[0].positionTicks,
      ...(sorted.at(-1).fadeOutDurationTicks === undefined
        ? {}
        : { fadeOutDurationTicks: sorted.at(-1).fadeOutDurationTicks }),
      ...(sorted.at(-1).fadeOutSlope === undefined
        ? {}
        : { fadeOutSlope: sorted.at(-1).fadeOutSlope }),
    },
    removeIds: sorted.slice(1).map((segment) => segment.id),
  }
}
