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

export interface CueOwnedRegionFields extends CueRegionTickFields {
  isEnabled: boolean
  colorIndex: number
  displayName: string
}

export interface CueAudioRegionFields<TPointer = unknown> {
  region: CueOwnedRegionFields
  track: TPointer
  playbackAutomationCollection: TPointer
  sample: TPointer
  gain: number
  fadeInDurationTicks: number
  fadeInSlope: number
  fadeOutDurationTicks: number
  fadeOutSlope: number
  timestretchMode: number
  pitchShiftSemitones: number
}

export interface CueAudioRegionOverwrites {
  region?: Partial<CueOwnedRegionFields>
  gain?: number
  fadeInDurationTicks?: number
  fadeInSlope?: number
  fadeOutDurationTicks?: number
  fadeOutSlope?: number
  timestretchMode?: number
  pitchShiftSemitones?: number
}

export function buildIndependentAudioRegionCopy<TPointer>(
  source: CueAudioRegionFields<TPointer>,
  overwrites?: CueAudioRegionOverwrites,
): CueAudioRegionFields<TPointer>

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
