export const TRANSPORT_CHANNEL: 'magic-deck.transport.v1'
export const TRANSPORT_RESPONSE_MAX_AGE_MS: 2000
export const TRANSPORT_REQUEST_TIMEOUT_MS: 1500

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
  | { ok: true; bar: number; raw?: string; capturedAt: number }
  | { ok: false; reason: string }

export function normalizeProjectId(value: unknown): string | null
export function projectIdFromUrl(value: unknown): string | null
export function parseTransportBar(raw: unknown): number | null
export function matchProjectTabs<T extends BrowserTab>(tabs: T[], projectId: string): ProjectTabMatch<T>
export function validateTransportResponse(
  response: unknown,
  expected: Pick<TransportRequest, 'requestId' | 'projectId'>,
  now?: number,
): ValidatedTransportResponse
export function barToPositionTicks(bar: number, ticksPerBar: number): number
