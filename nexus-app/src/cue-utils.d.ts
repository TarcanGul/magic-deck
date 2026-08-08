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

export interface CueRegionDuplicateInput<TPointer = unknown> {
  source: CueAudioRegionFields<TPointer>
  playbackAutomationCollection: TPointer
  targetPositionTicks: number
  fullDurationTicks: number
  cuePosition: number
}

export function planCueRegionDuplicate<TPointer>(input: CueRegionDuplicateInput<TPointer>): {
  region: CueAudioRegionFields<TPointer>
  cueOffsetTicks: number
  remainingDurationTicks: number
  automationTerminalTicks: number
}

export interface MagicCueLoopLaunchInput<TPointer = unknown> {
  source: CueAudioRegionFields<TPointer>
  targetPositionTicks: number
  loopDurationTicks: number
  scheduledDurationTicks: number
  cuePosition: number
}

export function planMagicCueLoopLaunch<TPointer>(input: MagicCueLoopLaunchInput<TPointer>): {
  region: CueAudioRegionFields<TPointer>
  cueOffsetTicks: number
  firstLoopDurationTicks: number
  scheduledDurationTicks: number
}

export interface SourceInstanceTimingResizeInput {
  positionTicks: number
  durationTicks: number
  collectionOffsetTicks: number
  loopOffsetTicks: number
  loopDurationTicks: number
  previousFullDurationTicks: number
  nextFullDurationTicks: number
}

export function planSourceInstanceTimingResize(input: SourceInstanceTimingResizeInput): {
  positionTicks: number
  durationTicks: number
  collectionOffsetTicks: number
  loopOffsetTicks: number
  loopDurationTicks: number
  automationTerminalTicks: number
  explicitlyShortened: boolean
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

export function cuePositionForBar(
  bar: number,
  ticksPerBar: number,
  fullDurationTicks: number,
): number

export function cueBarForPosition(
  position: number,
  ticksPerBar: number,
  fullDurationTicks: number,
): number

export interface LegacyCueChainSegment {
  id: string
  positionTicks: number
  durationTicks: number
  [field: string]: unknown
}

export function planLegacyCueChainCollapse(segments: LegacyCueChainSegment[]): {
  keepId: string
  durationTicks: number
  collapsedRegion: LegacyCueChainSegment
  removeIds: string[]
}
