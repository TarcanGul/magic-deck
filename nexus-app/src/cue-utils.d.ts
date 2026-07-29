export interface CueRegionTickFields {
  positionTicks: number
  durationTicks: number
  collectionOffsetTicks: number
  loopOffsetTicks: number
  loopDurationTicks: number
}

export interface CueRegionSegment {
  id: string
  positionTicks: number
  durationTicks: number
}

export function planAudioRegionSplit(
  region: CueRegionTickFields,
  cutTicks: number,
): {
  leftDurationTicks: number
  right: CueRegionTickFields
}

export function cuePositionsFromSegments(segments: CueRegionSegment[]): number[]

export interface CueOffsetResizeInput {
  firstCollectionOffsetTicks: number
  firstLoopOffsetTicks: number
  loopDurationTicks: number
  previousContentDurationTicks: number
  nextContentDurationTicks: number
  nextStartTicks: number
}

export function planResizedCueOffsets(input: CueOffsetResizeInput): {
  collectionOffsetTicks: number
  loopOffsetTicks: number
  loopDurationTicks: number
}
