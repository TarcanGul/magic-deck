function compareRegionStart(a, b) {
  return a.positionTicks - b.positionTicks || a.id.localeCompare(b.id)
}

function regionEnd(region) {
  return region.positionTicks + region.durationTicks
}

function logicalRegionKey(region) {
  return `${region.sampleId}\u0000${region.automationCollectionId}`
}

export function buildLogicalRegionChains(regions) {
  const groups = new Map()
  regions.forEach((region) => {
    const key = logicalRegionKey(region)
    const group = groups.get(key)
    if (group) group.push(region)
    else groups.set(key, [region])
  })

  const chains = []
  groups.forEach((group) => {
    group.sort(compareRegionStart)
    let chain = []
    let chainEnd = -Infinity
    group.forEach((region) => {
      if (chain.length > 0 && region.positionTicks !== chainEnd) {
        chains.push(chain)
        chain = []
        chainEnd = -Infinity
      }
      chain.push(region)
      chainEnd = Math.max(chainEnd, regionEnd(region))
    })
    if (chain.length > 0) chains.push(chain)
  })
  return chains
}

export function selectLatestLogicalRegion(regions) {
  const candidates = buildLogicalRegionChains(regions)
    .map((chain) => chain.slice().sort(compareRegionStart)[0])
    .sort((a, b) =>
      b.positionTicks - a.positionTicks
      || b.id.localeCompare(a.id))
  return candidates[0] ?? null
}

export function logicalRegionChainIds(regions, controlledRegionId) {
  const chain = buildLogicalRegionChains(regions)
    .find((candidate) => candidate.some((region) => region.id === controlledRegionId))
  return chain?.map((region) => region.id) ?? []
}

export function clampRegionFades(durationTicks, fadeInDurationTicks, fadeOutDurationTicks) {
  const fadeIn = Math.min(Math.max(0, fadeInDurationTicks), durationTicks)
  const fadeOut = Math.min(
    Math.max(0, fadeOutDurationTicks),
    Math.max(0, durationTicks - fadeIn),
  )
  return { fadeInDurationTicks: fadeIn, fadeOutDurationTicks: fadeOut }
}

export function planForwardTimelineInsertion(regions, insertionTicks) {
  if (!Number.isSafeInteger(insertionTicks) || insertionTicks < 0) {
    throw new Error('Insertion position must be a non-negative safe integer')
  }
  if (regions.some((region) => region.positionTicks === insertionTicks)) {
    return { kind: 'reject', reason: 'region-starts-at-boundary' }
  }

  const latest = selectLatestLogicalRegion(regions)
  if (latest && insertionTicks < latest.positionTicks) {
    return { kind: 'reject', reason: 'backward-placement' }
  }

  const truncate = []
  const removeIds = new Set()
  buildLogicalRegionChains(regions).forEach((chain) => {
    const crossing = chain.find((region) =>
      region.positionTicks < insertionTicks
      && regionEnd(region) > insertionTicks)
    if (!crossing) return

    const durationTicks = insertionTicks - crossing.positionTicks
    truncate.push({
      id: crossing.id,
      durationTicks,
      ...clampRegionFades(
        durationTicks,
        crossing.fadeInDurationTicks,
        crossing.fadeOutDurationTicks,
      ),
    })
    chain.forEach((region) => {
      if (region.positionTicks > crossing.positionTicks) removeIds.add(region.id)
    })
  })

  return {
    kind: 'insert',
    truncate,
    removeRegionIds: [...removeIds].sort(),
  }
}

export function selectCanonicalRouting(candidates, canonicalName) {
  const ordered = candidates.slice().sort((a, b) =>
    a.trackOrder - b.trackOrder
    || a.trackId.localeCompare(b.trackId)
    || (a.routingId ?? '').localeCompare(b.routingId ?? ''))
  return ordered.find((candidate) =>
    candidate.deviceName === canonicalName
    && candidate.stripName === canonicalName)
    ?? ordered.find((candidate) => {
      const normalizedName = canonicalName.toUpperCase()
      const deviceName = candidate.deviceName.toUpperCase()
      const stripName = candidate.stripName.toUpperCase()
      const prefix = `${normalizedName} `
      const separators = [`${normalizedName}—`, `${normalizedName}–`, `${normalizedName}-`]
      return (
        deviceName.startsWith(prefix)
        || separators.some((separator) => deviceName.startsWith(separator))
      ) && (
        stripName === normalizedName
        || stripName.startsWith(prefix)
        || separators.some((separator) => stripName.startsWith(separator))
      )
    })
    ?? null
}
