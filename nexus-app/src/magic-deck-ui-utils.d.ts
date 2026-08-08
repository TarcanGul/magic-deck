export type MagicStatusState = 'idle' | 'generating' | 'error' | 'done' | 'warning'
export type MagicContentKind = 'empty' | 'generated' | 'restored'

export interface MagicStatus {
  state: MagicStatusState
  label: string
}

export interface MagicStatusTimers {
  setTimeout(callback: () => void, durationMs: number): ReturnType<typeof globalThis.setTimeout>
  clearTimeout(timer: ReturnType<typeof globalThis.setTimeout>): void
}

export interface MagicStatusController {
  show(status: MagicStatus): void
  setResting(content: MagicContentKind, detail?: string): void
  showTemporary(status: MagicStatus, durationMs: number): void
  clear(): void
  getResting(): MagicStatus
}

export interface DeckFxAvailabilityOptions {
  projectConnected: boolean
  hasProjectDocument: boolean
  deckIndex: 0 | 1 | 2
  pendingCount: number
  activeKind: string | null
  hasPlayableMagicContent: boolean
  activeFxDeckIndex: 0 | 1 | 2 | null
  hasActiveLibrary: boolean
}

export function magicRestingStatus(content: MagicContentKind, detail?: string): MagicStatus
export function createMagicStatusController(
  render: (status: MagicStatus) => void,
  timers?: MagicStatusTimers,
): MagicStatusController
export function isDeckFxAvailable(options: DeckFxAvailabilityOptions): boolean
