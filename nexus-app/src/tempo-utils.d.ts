export const TEMPO_RANGES: readonly [10, 30, 50]
export type TempoRange = typeof TEMPO_RANGES[number]

export function tempoPercentToPlaybackRate(percent: number): number
export function effectiveBpm(sourceBpm: number, percent: number): number
export function tempoPercentForBpm(sourceBpm: number, targetBpm: number): number
export function clampTempoPercent(percent: number, range: TempoRange): number
export function smallestTempoRange(percent: number): TempoRange | null
export function mappedDurationTicks(nativeDurationTicks: number, percent: number): number
export function reconstructTempoPercent(
  nativeDurationTicks: number,
  mappedDurationTicks: number,
): number
