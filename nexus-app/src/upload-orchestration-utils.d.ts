export type UploadPhase =
  | 'preparing'
  | 'uploading'
  | 'detecting-bpm'
  | 'processing'
  | 'inserting'
  | 'ready'
  | 'failed'

export interface UploadPhaseTiming {
  startedAtMs: number
  completedAtMs?: number
  durationMs?: number
  outcome?: string
}

export interface UploadProgressSnapshot {
  outcome: string
  active: UploadPhase[]
  timings: Partial<Record<UploadPhase, UploadPhaseTiming>>
  totalDurationMs: number
  failure: string | null
}

export interface AubioEstimate {
  bpm: number | null
  confidence: number
  reliable: boolean
}

export type BpmRaceDecision =
  | { kind: 'accepted'; bpm: number; source: 'audiotool' | 'aubio' }
  | { kind: 'confirmation'; estimate: AubioEstimate | null; aubioError: string | null }

export const UPLOAD_PHASES: readonly UploadPhase[]

export function startConcurrentTasks<TUpload, TBpm, TDuration>(starters: {
  upload: () => TUpload | Promise<TUpload>
  bpm: () => TBpm | Promise<TBpm>
  duration: () => TDuration | Promise<TDuration>
}): {
  upload: Promise<TUpload>
  bpm: Promise<TBpm>
  duration: Promise<TDuration>
}

export function createPerKeyTaskQueue(keyCount: number): {
  enqueue<T>(key: number, task: () => T | Promise<T>): Promise<T>
}

export function isCurrentSession(expectedSession: number, currentSession: number): boolean
export function isSupportedBpmValue(value: unknown, minimum?: number, maximum?: number): boolean
export function resolveBpmRace(
  audiotoolBpm: Promise<number | null | undefined>,
  aubioResult: Promise<AubioEstimate>,
  options?: { minimum?: number; maximum?: number; confidenceThreshold?: number },
): Promise<BpmRaceDecision>

export function createUploadTimingRecorder(options?: {
  now?: () => number
  onChange?: (snapshot: UploadProgressSnapshot) => void
}): {
  begin(phase: UploadPhase): void
  end(phase: UploadPhase, outcome?: string): void
  fail(error: unknown): void
  complete<T extends object>(details?: T): UploadProgressSnapshot & T
  snapshot(): UploadProgressSnapshot
}

export function uploadProgressText(progress: UploadProgressSnapshot | null | undefined): string

export function settlePendingInsertion<TInserted, TSample>(
  ready: Promise<TSample>,
  inserted: TInserted,
  handlers: {
    hydrate(inserted: TInserted, sample: TSample): void | Promise<void>
    cleanup(inserted: TInserted): void | Promise<void>
  },
): Promise<TSample>
