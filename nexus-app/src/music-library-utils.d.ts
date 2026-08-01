export type MusicLibrarySortKey = 'name' | 'size' | 'modified'
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

export interface MusicLibraryFolderNode {
  kind: 'folder'
  id: string
  name: string
  relativePath: string
  parentId: string | null
  size: number
  lastModified: number
  children: MusicLibraryNode[]
}

export interface MusicLibraryTrackNode<
  TFileHandle = FileSystemFileHandle,
  TFile = File,
> extends MusicLibraryEntry<TFileHandle, TFile> {
  kind: 'track'
  parentId: string | null
}

export type MusicLibraryNode = MusicLibraryFolderNode | MusicLibraryTrackNode

export interface VisibleMusicLibraryNode {
  node: MusicLibraryNode
  depth: number
  expanded: boolean
}

export interface MusicLibraryTreeOptions {
  expandedFolderIds?: ReadonlySet<string>
  query?: string
  sortKey?: MusicLibrarySortKey
  sortDirection?: MusicLibrarySortDirection
}

export type MusicLibraryTreeAction = {
  type: 'none' | 'select' | 'expand' | 'collapse' | 'activate'
  id: string | null
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
export function buildMusicLibraryTree(entries: readonly MusicLibraryEntry[]): MusicLibraryNode[]
export function flattenMusicLibraryTree(
  nodes: readonly MusicLibraryNode[],
  options?: MusicLibraryTreeOptions,
): VisibleMusicLibraryNode[]
export function findMusicLibraryNode(
  nodes: readonly MusicLibraryNode[],
  nodeId: string | null,
): MusicLibraryNode | null
export function findMusicLibraryParentNode(
  nodes: readonly MusicLibraryNode[],
  nodeId: string | null,
): MusicLibraryFolderNode | null
export function recoverMusicLibrarySelectionId(
  selectedId: string | null,
  visibleNodes: readonly VisibleMusicLibraryNode[],
): string | null
export function musicLibraryTreeKeyAction(
  visibleNodes: readonly VisibleMusicLibraryNode[],
  selectedId: string | null,
  key: string,
  pageSize?: number,
): MusicLibraryTreeAction
export function nextMusicSelectionIndex(
  currentIndex: number,
  key: string,
  entryCount: number,
  pageSize?: number,
): number
