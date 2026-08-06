export interface CueViewport {
  zoomLevel: number
  start: number
  end: number
}

export const CUE_ZOOM_LEVELS: readonly number[]
export function createCueViewport(zoomLevel?: number, center?: number): CueViewport
export function zoomCueViewport(
  viewport: CueViewport,
  zoomLevel: number,
  anchorPosition: number,
  anchorRatio?: number,
): CueViewport
export function panCueViewport(viewport: CueViewport, delta: number): CueViewport
export function cuePositionFromPointer(
  pointerX: number,
  width: number,
  viewport: CueViewport,
): number
export function clampCueTicks(positionTicks: number, durationTicks: number): number
export function normalizedCuePositionToTicks(position: number, durationTicks: number): number
export function cueTicksToNormalizedPosition(positionTicks: number, durationTicks: number): number
export function formatCueTickPosition(
  positionTicks: number,
  durationTicks: number,
  ticksPerBar: number,
  ticksPerBeat: number,
  durationSeconds: number,
): string
