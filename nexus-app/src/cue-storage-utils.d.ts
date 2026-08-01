export type CuePointSlots = [number | null, number | null, number | null, number | null, number | null]

export interface StoredCuePointsV1 {
  version: 1
  audioFootprint: string
  points: CuePointSlots
}

export interface StoredCuePointsV2 {
  version: 2
  audioFootprint: string
  points: CuePointSlots
  updatedAt: number
}

interface CueStorageAdapters {
  audioFootprint: string
  readPersistent: () => Promise<unknown>
  readSession: () => Promise<unknown>
  writePersistent: (record: StoredCuePointsV2) => Promise<void>
  writeSession: (record: StoredCuePointsV1) => Promise<void>
  removeSession: () => Promise<void>
  now?: () => number
}

export const CUE_POINT_SLOT_COUNT: 5
export function emptyCuePointSlots(): CuePointSlots
export function validCuePosition(value: unknown): value is number
export function parseCueRecordV1(value: unknown, audioFootprint: string): CuePointSlots | null
export function parseCueRecordV2(value: unknown, audioFootprint: string): StoredCuePointsV2 | null
export function reconcileLegacyCuePoints(
  sessionPoints: unknown,
  authoritativePoints: unknown,
): CuePointSlots
export function loadCuePointMetadata(
  adapters: CueStorageAdapters & { authoritativePoints?: number[] },
): Promise<{
  points: CuePointSlots
  persistence: 'indexeddb' | 'session'
  migrated: boolean
  error?: unknown
}>
export function saveCuePointMetadata(
  adapters: Omit<CueStorageAdapters, 'readPersistent' | 'readSession' | 'removeSession'> & {
    points: CuePointSlots
  },
): Promise<{ persistence: 'indexeddb' | 'session'; error?: unknown }>
