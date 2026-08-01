export const TRANSPORT_CHANNEL: 'magic-deck.transport.v2'
export const TRANSPORT_RESPONSE_MAX_AGE_MS: 2000
export const TRANSPORT_REQUEST_TIMEOUT_MS: 1500
export const NEXUS_DELIVERY_GUARD_MS: 750
export const TRANSPORT_TICKS_PER_BEAT: 3840

export type LaunchQuantization = 'next-bar' | 'next-phrase' | 'exact-bar'
export type LaunchDirection = 'previous' | 'next'
export type LaunchStep = 'beat' | 'bar' | 'four-bars'
export type LaunchPositionAction =
  | 'previous-beat'
  | 'next-beat'
  | 'previous-bar'
  | 'next-bar'
  | 'previous-four-bars'
  | 'next-four-bars'
  | 'reenter-bar'

export interface TransportPosition {
  bar: number
  beat?: number
  tick?: number
  precision: 'bar' | 'beat' | 'tick'
  capturedAt: number
}

export interface TransportRequest {
  channel: typeof TRANSPORT_CHANNEL
  type: 'request'
  requestId: string
  projectId: string
  deckIndex: 0 | 1 | 2
}

export interface TransportResponse {
  channel: typeof TRANSPORT_CHANNEL
  type: 'response'
  requestId: string
  projectId: string
  ok: boolean
  bar?: number
  beat?: number
  tick?: number
  precision?: TransportPosition['precision']
  raw?: string
  capturedAt: number
  reason?: string
}

export interface BrowserTab {
  id?: number
  url?: string
}

export type ProjectTabMatch<T extends BrowserTab> =
  | { ok: true; tab: T }
  | { ok: false; reason: string }

export type ValidatedTransportResponse =
  | { ok: true; position: TransportPosition; raw?: string }
  | { ok: false; reason: string }

export function normalizeProjectId(value: unknown): string | null
export function projectIdFromUrl(value: unknown): string | null
export function parseTransportPosition(raw: unknown, capturedAt?: number): TransportPosition | null
export function validateTransportPosition(
  value: unknown,
  capturedAt?: number,
  ticksPerBeat?: number,
): TransportPosition | null
export function mergeTransportPositions(positions: unknown[]): TransportPosition | null
export function matchProjectTabs<T extends BrowserTab>(tabs: T[], projectId: string): ProjectTabMatch<T>
export function validateTransportResponse(
  response: unknown,
  expected: Pick<TransportRequest, 'requestId' | 'projectId'>,
  now?: number,
): ValidatedTransportResponse
export function barToPositionTicks(bar: number, ticksPerBar: number): number
export function transportPositionToTicks(
  position: TransportPosition,
  ticksPerBeat: number,
  ticksPerBar: number,
): number
export function guardedTransportTicks(
  position: TransportPosition,
  bpm: number,
  now: number,
  ticksPerBeat: number,
  ticksPerBar: number,
  deliveryGuardMs?: number,
): number
export function resolveLaunchTick(
  quantization: LaunchQuantization,
  guardedTicks: number,
  ticksPerBar: number,
  exactBar?: number,
): number | null
export function moveLaunchPosition(
  positionTicks: number,
  action: Exclude<LaunchPositionAction, 'reenter-bar'>,
  ticksPerBeat: number,
  ticksPerBar: number,
): number
export function composeLaunchPositionAction(
  direction: LaunchDirection,
  step: LaunchStep,
): Exclude<LaunchPositionAction, 'reenter-bar'>
export function tickToBar(tick: number, ticksPerBar: number): number

export type RegionLaunchPlan = {
  kind: 'launch'
  positionTicks: number
  cueOffsetTicks: number
  durationTicks: number
  isEnabled: true
}
export type RegionCancelPlan =
  | { kind: 'cancel'; isEnabled: false }
  | { kind: 'refuse'; reason: 'launch-boundary-reached' }
export type RegionStopPlan =
  | { kind: 'cancel'; isEnabled: false }
  | { kind: 'stop'; durationTicks: number }
  | { kind: 'noop'; reason: 'region-disabled' | 'natural-end-first' }

export function planRegionLaunch(
  fullDurationTicks: number,
  targetTicks: number,
  cuePosition?: number,
): RegionLaunchPlan
export function planRegionCancel(regionStartTicks: number, guardedTicks: number): RegionCancelPlan
export function planRegionStop(
  regionStartTicks: number,
  currentDurationTicks: number,
  fullDurationTicks: number,
  isEnabled: boolean,
  guardedTicks: number,
  targetTicks: number,
): RegionStopPlan
