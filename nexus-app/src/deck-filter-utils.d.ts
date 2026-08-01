export type DeckFilterKind = 'hpf' | 'lpf'

export const DECK_FILTER_MIN_HZ: number
export const DECK_FILTER_MAX_HZ: number

export function filterValueToFrequency(value: number): number
export function filterFrequencyToValue(frequencyHz: number): number
export function neutralFilterValue(kind: DeckFilterKind): number
