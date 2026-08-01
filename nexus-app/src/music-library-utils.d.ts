export type MusicLibrarySortKey = 'name' | 'folder' | 'size' | 'modified'
export type MusicLibrarySortDirection = 'ascending' | 'descending'

export interface MusicLibraryEntry<
  TFileHandle = FileSystemFileHandle,
  TFile = File,
> {
  id: string
  name: string
  folder: string
  relativePath: string
  size: number
  lastModified: number
  fileHandle: TFileHandle | null
  file: TFile | null
}

export function isSupportedMusicFile(name: string): boolean
export function normalizeLibraryPath(path: string): string
export function indexMusicDirectory(
  rootHandle: FileSystemDirectoryHandle,
): Promise<MusicLibraryEntry[]>
export function indexMusicFiles(files: Iterable<File>): MusicLibraryEntry[]
export function filterMusicEntries(
  entries: readonly MusicLibraryEntry[],
  query: string,
): MusicLibraryEntry[]
export function sortMusicEntries(
  entries: readonly MusicLibraryEntry[],
  key: MusicLibrarySortKey,
  direction: MusicLibrarySortDirection,
): MusicLibraryEntry[]
export function nextMusicSelectionIndex(
  currentIndex: number,
  key: string,
  entryCount: number,
  pageSize?: number,
): number
