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
