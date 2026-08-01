export interface TimelineRegionSnapshot {
  id: string
  sampleId: string
  automationCollectionId: string
  positionTicks: number
  durationTicks: number
  fadeInDurationTicks: number
  fadeOutDurationTicks: number
}

export interface RegionTruncation {
  id: string
  durationTicks: number
  fadeInDurationTicks: number
  fadeOutDurationTicks: number
}

export interface RoutingCandidate {
  trackId: string
  trackOrder: number
  deviceName: string
  stripName: string
  routingId?: string
}

export function buildLogicalRegionChains<T extends TimelineRegionSnapshot>(regions: T[]): T[][]
export function selectLatestLogicalRegion<T extends TimelineRegionSnapshot>(regions: T[]): T | null
export function logicalRegionChainIds(
  regions: TimelineRegionSnapshot[],
  controlledRegionId: string,
): string[]
export function clampRegionFades(
  durationTicks: number,
  fadeInDurationTicks: number,
  fadeOutDurationTicks: number,
): { fadeInDurationTicks: number; fadeOutDurationTicks: number }
export function planForwardTimelineInsertion(
  regions: TimelineRegionSnapshot[],
  insertionTicks: number,
):
  | { kind: 'reject'; reason: 'region-starts-at-boundary' | 'backward-placement' }
  | { kind: 'insert'; truncate: RegionTruncation[]; removeRegionIds: string[] }
export function planNonOverlappingCueTakeover(
  regions: TimelineRegionSnapshot[],
  positionTicks: number,
  durationTicks: number,
): { truncate: RegionTruncation[]; removeRegionIds: string[] }
export function selectCanonicalRouting<T extends RoutingCandidate>(
  candidates: T[],
  canonicalName: string,
): T | null
