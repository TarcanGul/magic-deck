export const DECK_FILTER_MIN_HZ = 20
export const DECK_FILTER_MAX_HZ = 20000

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

export function filterValueToFrequency(value) {
  const normalizedValue = clamp(value, 0, 1)
  const frequencyRatio = DECK_FILTER_MAX_HZ / DECK_FILTER_MIN_HZ
  return DECK_FILTER_MIN_HZ * frequencyRatio ** normalizedValue
}

export function filterFrequencyToValue(frequencyHz) {
  const frequency = clamp(frequencyHz, DECK_FILTER_MIN_HZ, DECK_FILTER_MAX_HZ)
  const frequencyRatio = DECK_FILTER_MAX_HZ / DECK_FILTER_MIN_HZ
  return Math.log(frequency / DECK_FILTER_MIN_HZ) / Math.log(frequencyRatio)
}

export function neutralFilterValue(kind) {
  return kind === 'hpf' ? 0 : 1
}
