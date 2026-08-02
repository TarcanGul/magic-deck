export interface SourceUploadSettings {
  chunkingEnabled: boolean
  chunkDurationSeconds: number
  uploadConcurrency: number
}
export interface SourceChunkPlan {
  index: number
  startFrame: number
  endFrame: number
  frameLength: number
  startSeconds: number
  durationSeconds: number
  cueSlots: number[]
}
export interface ChunkProgressItem { state: string; attempts?: number }
export const SOURCE_UPLOAD_SETTINGS_KEY: string
export const DEFAULT_SOURCE_UPLOAD_SETTINGS: Readonly<SourceUploadSettings>
export function normalizeSourceUploadSettings(value?: Partial<SourceUploadSettings>): SourceUploadSettings
export function loadSourceUploadSettings(storage?: Pick<Storage, 'getItem'>): SourceUploadSettings
export function saveSourceUploadSettings(storage: Pick<Storage, 'setItem'> | undefined, settings: Partial<SourceUploadSettings>): SourceUploadSettings
export function normalizedCuePositions(cueSlots: ReadonlyArray<number | null>): Array<{ position: number; cueSlot: number }>
export function scaleCuePositions(cueSlots: ReadonlyArray<number | null>, durationFrames: number): Array<{ cueSlot: number; position: number; frame: number }>
export function planSourceChunks(options: { durationFrames: number; sampleRate: number; cueSlots?: ReadonlyArray<number | null>; maximumSeconds?: number; chunkingEnabled?: boolean }): SourceChunkPlan[]
export function prioritizeSourceChunks(chunks: readonly SourceChunkPlan[]): SourceChunkPlan[]
export function audioChannelsSlice(channels: readonly Float32Array[], startFrame: number, endFrame: number): Float32Array[]
export function encodePcm16Wav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer
export function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => R | Promise<R>): Promise<R[]>
export function retryWithBackoff<T>(task: (attempt: number) => T | Promise<T>, options?: { attempts?: number; baseDelayMs?: number; signal?: AbortSignal; wait?: (delay: number, signal?: AbortSignal) => void | Promise<void>; onAttempt?: (attempt: number) => void; onFailure?: (error: unknown, attempt: number) => void | Promise<void> }): Promise<T>
export function aggregateChunkProgress(chunks: readonly ChunkProgressItem[], phase?: string): { total: number; ready: number; failed: number; retrying: number; attempts: number; phase: string }
export function logicalTrackContains(group: { sessionId: number; regions: Array<{ id: string }> } | null, regionId: string, sessionId: number): boolean
export function transitionUploadPhase(current: string, next: string): string
