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

export function planDeckTrackClear(regions, trackId, catalogDependencies = []) {
  const regionsToRemove = regions.filter((region) => region.trackId === trackId)
  const regionIds = new Set(regionsToRemove.map((region) => region.id))
  const sampleIds = new Set(regionsToRemove.map((region) => region.sampleId))
  const automationCollectionIds = new Set(
    regionsToRemove.map((region) => region.automationCollectionId),
  )

  catalogDependencies.forEach((dependency) => {
    if (dependency.sampleId) sampleIds.add(dependency.sampleId)
    if (dependency.automationCollectionId) {
      automationCollectionIds.add(dependency.automationCollectionId)
    }
  })

  regions.forEach((region) => {
    if (regionIds.has(region.id)) return
    sampleIds.delete(region.sampleId)
    automationCollectionIds.delete(region.automationCollectionId)
  })

  return {
    regionIds: [...regionIds].sort(),
    sampleIds: [...sampleIds].sort(),
    automationCollectionIds: [...automationCollectionIds].sort(),
  }
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

  const overwritesFromBoundary = regions.some((region) =>
    region.positionTicks === insertionTicks)
  const latest = selectLatestLogicalRegion(regions)
  if (!overwritesFromBoundary && latest && insertionTicks < latest.positionTicks) {
    return { kind: 'reject', reason: 'backward-placement' }
  }

  const truncate = []
  const removeIds = new Set()
  buildLogicalRegionChains(regions).forEach((chain) => {
    if (overwritesFromBoundary) {
      chain.forEach((region) => {
        if (region.positionTicks >= insertionTicks) removeIds.add(region.id)
      })
    }
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

export function planNonOverlappingCueTakeover(regions, positionTicks, durationTicks) {
  if (
    !Number.isSafeInteger(positionTicks)
    || positionTicks < 0
    || !Number.isSafeInteger(durationTicks)
    || durationTicks <= 0
    || !Number.isSafeInteger(positionTicks + durationTicks)
  ) throw new Error('Cue takeover requires a positive safe timeline range')

  const takeoverEndTicks = positionTicks + durationTicks
  const ordered = [...regions].sort(compareRegionStart)
  const removeIds = new Set()
  const plannedDurations = new Map()

  ordered.forEach((region, index) => {
    if (
      !Number.isSafeInteger(region.positionTicks)
      || region.positionTicks < 0
      || !Number.isSafeInteger(region.durationTicks)
      || region.durationTicks <= 0
      || !Number.isSafeInteger(regionEnd(region))
    ) throw new Error('Cue takeover found invalid deck region timing')
    const next = ordered[index + 1]
    if (!next) return
    if (next.positionTicks === region.positionTicks) {
      removeIds.add(region.id)
      return
    }
    if (regionEnd(region) > next.positionTicks) {
      plannedDurations.set(region.id, next.positionTicks - region.positionTicks)
    }
  })

  ordered.forEach((region) => {
    if (removeIds.has(region.id)) return
    const plannedDuration = plannedDurations.get(region.id) ?? region.durationTicks
    const plannedEndTicks = region.positionTicks + plannedDuration
    if (region.positionTicks >= positionTicks && region.positionTicks < takeoverEndTicks) {
      removeIds.add(region.id)
      plannedDurations.delete(region.id)
      return
    }
    if (region.positionTicks < positionTicks && plannedEndTicks > positionTicks) {
      plannedDurations.set(region.id, positionTicks - region.positionTicks)
    }
  })

  const truncate = ordered.flatMap((region) => {
    if (removeIds.has(region.id)) return []
    const nextDurationTicks = plannedDurations.get(region.id)
    if (nextDurationTicks === undefined || nextDurationTicks === region.durationTicks) return []
    return [{
      id: region.id,
      durationTicks: nextDurationTicks,
      ...clampRegionFades(
        nextDurationTicks,
        region.fadeInDurationTicks,
        region.fadeOutDurationTicks,
      ),
    }]
  })
  return {
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
