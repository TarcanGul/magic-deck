import { audiotool } from '@audiotool/nexus'
import { secondsToTicks, Ticks } from '@audiotool/nexus/utils'
import type { AuthenticatedClient, SyncedDocument } from '@audiotool/nexus'
import type { SampleMeta } from '@audiotool/nexus/api'
import type { EntityQuery, NexusEntity, SafeTransactionBuilder } from '@audiotool/nexus/document'
import type { Terminable } from '@audiotool/nexus/utils'
import {
  TRANSPORT_CHANNEL,
  TRANSPORT_REQUEST_TIMEOUT_MS,
  barToPositionTicks,
  composeLaunchPositionAction,
  guardedTransportTicks,
  moveLaunchPosition,
  planRegionCancel,
  planRegionLaunch,
  planRegionStop,
  projectIdFromUrl,
  resolveLaunchTick,
  tickToBar,
  validateTransportResponse,
} from '../transport-extension/transport-utils.js'
import type {
  LaunchDirection,
  LaunchPositionAction,
  LaunchStep,
  TransportRequest,
  TransportPosition,
  TransportResponse,
} from '../transport-extension/transport-utils.js'
import {
  clampTempoPercent,
  effectiveBpm,
  mappedDurationTicks,
  reconstructTempoPercent,
  smallestTempoRange,
  tempoPercentForBpm,
  tempoPercentToPlaybackRate,
} from './tempo-utils.js'
import type { TempoRange } from './tempo-utils.js'
import {
  planForwardTimelineInsertion,
  planNonOverlappingCueTakeover,
  selectCanonicalRouting,
  selectLatestLogicalRegion,
} from './deck-project-utils.js'
import type { TimelineRegionSnapshot } from './deck-project-utils.js'
import { staleOAuthCallbackUrl } from './auth-utils.js'
import {
  buildIndependentAudioRegionCopy,
  cueBarForPosition,
  cuePositionForBar,
  cuePositionsFromSegments,
  planCueRegionDuplicate,
  planLegacyCueChainCollapse,
  planAudioRegionSplit,
  planResizedCueOffsets,
  planSourceInstanceTimingResize,
} from './cue-utils.js'
import {
  emptyCuePointSlots,
  loadCuePointMetadata,
  parseCueRecordV1,
  reconcileLegacyCuePoints,
  saveCuePointMetadata,
} from './cue-storage-utils.js'
import type {
  CuePointSlots,
  StoredCuePointsV1,
  StoredCuePointsV2,
} from './cue-storage-utils.js'
import {
  buildMusicLibraryTree,
  findMusicLibraryNode,
  flattenMusicLibraryTree,
  indexMusicDirectory,
  indexMusicFiles,
  isSupportedMusicFile,
  musicLibraryTreeKeyAction,
  recoverMusicLibrarySelectionId,
} from './music-library-utils.js'
import type {
  MusicLibraryEntry,
  MusicLibraryNode,
  MusicLibrarySortDirection,
  MusicLibrarySortKey,
} from './music-library-utils.js'
import {
  DECK_FILTER_MAX_HZ,
  DECK_FILTER_MIN_HZ,
  filterFrequencyToValue,
  filterValueToFrequency,
  neutralFilterValue,
} from './deck-filter-utils.js'
import type { DeckFilterKind } from './deck-filter-utils.js'

// ── OAuth config ──────────────────────────────────────────────────────────────
const CLIENT_ID = 'fa370480-13d6-4cba-8015-f9297a81e9e8'
const REDIRECT_URL = 'http://127.0.0.1:5173/'
const SCOPE = 'project:write sample:write'
const OAUTH_STATE_STORAGE_KEY = `oidc_${CLIENT_ID}_oidc_state`

// ── Types ─────────────────────────────────────────────────────────────────────
interface DeckState {
  audioCtx: AudioContext | null; audioBuffer: AudioBuffer | null
  cueLoadId: number
  audioFootprint: string | null; cuePoints: CuePointSlots; cuePosition: number; cueLoading: boolean
  scheduledCuePosition: number; cuePersistenceWarning: boolean
  fileName: string | null
  baseBpm: number | null; pitchPercent: number; playbackRate: number
  tempoPercent: number; tempoRange: TempoRange; tempoSync: boolean
  tempoUpdatePending: boolean; pendingTempoPercent: number | null
  tempoWorker: Promise<void> | null; tempoReconcileScheduled: boolean
  lastAppliedTiming: TempoTimingSnapshot | null
  volume: number; gainTrim: number
  sampleBpm: number | null; sampleMeta: SampleMeta | null
  regionEntity: NexusEntity<'audioRegion'> | null
  trackEntity: NexusEntity<'audioTrack'> | null; audioDeviceEntity: NexusEntity<'audioDevice'> | null
  mixerChannelEntity: NexusEntity<'mixerChannel'> | null; sampleEntity: NexusEntity<'sample'> | null
  automationCollectionEntity: NexusEntity<'automationCollection'> | null
  cableEntity: NexusEntity<'desktopAudioCable'> | null
  fxGraph: DeckFxGraph | null
  contentSubscriptions: Terminable[]
  routingSubscriptions: Terminable[]
}
type DeckPrefix = 'd1' | 'd2' | 'd3'
type WaveformDeckIndex = 0 | 1 | 2
type EqBand = 'hi' | 'mid' | 'low'
type DeckFxKind = 'delay' | 'reverb' | 'distortion' | 'flanger'
const DECK_FX_KINDS: readonly DeckFxKind[] = ['delay', 'reverb', 'distortion', 'flanger']
type StemRole = 'auto' | 'drums' | 'bass' | 'melody' | 'texture'
interface ReferenceAudio {
  blob: Blob
  fileName: string
  sourceLabel: string
  seconds: number
}
interface CaptureChunk {
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
}
interface CaptureWorkletChunk extends CaptureChunk {
  type: 'chunk'
  recordingId: number
  capturedFrames: number
  targetFrames: number
}
interface CaptureWorkletComplete {
  type: 'complete'
  recordingId: number
  capturedFrames: number
  targetFrames: number
}
type CaptureWorkletMessage = CaptureWorkletChunk | CaptureWorkletComplete
interface ActiveLiveAudioRecording {
  recordingId: number
  targetFrames: number
  capturedFrames: number
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  lastProgressUpdate: number
  timeoutId: number
  resolve: (chunk: CaptureChunk) => void
  reject: (error: Error) => void
}
interface BpmResolution {
  bpm: number
  source: 'audiotool' | 'aubio' | 'manual' | 'project'
}
interface SampleTiming {
  bpm: number
  musicDurationTicks?: number
}
interface UploadToNexusOptions {
  timing?: SampleTiming
  sampleDescription?: string
  placement?: DeckInsertionPlacement
}
interface DeckInsertionPlacement {
  deckIndex: WaveformDeckIndex
  bar: number
  positionTicks: number
  source: 'extension' | 'manual' | 'project-start'
  capturedAt: number
}
interface AubioBpmResult {
  bpm: number | null
  confidence: number
  reliable: boolean
}
interface DeckOperationState {
  pendingCount: number
  activeKind: 'loading' | 'replacing' | 'unloading' | 'launching' | 'cue-scheduling' | 'cancelling' | 'stopping' | 'generating' | null
  uploading: boolean
  suppressProjectRemovalSync: boolean
}
interface ManualBpmReportState {
  editing: boolean
  pending: boolean
  requestId: number
}
interface NativeTimingResult {
  durationTicks: number
  replacementRegion: NexusEntity<'audioRegion'> | null
  regionDurationTicks?: number
  controlledRegionDurationTicks?: number
  replacements?: SourceTimingReplacement[]
}
interface TempoTimingSnapshot {
  projectBpm: number
  sourceBpm: number
  percent: number
  playbackRate: number
  mappedDurationTicks: number
  regionDurationTicks: number
}
interface SourceTimingReplacement {
  deckIndex: WaveformDeckIndex
  previousRegionId: string
  region: NexusEntity<'audioRegion'>
  automationCollection: NexusEntity<'automationCollection'>
}
interface ResolvedDeckRoutingGraph {
  track: NexusEntity<'audioTrack'>
  audioDevice: NexusEntity<'audioDevice'>
  mixerChannel: NexusEntity<'mixerChannel'>
  cable: NexusEntity<'desktopAudioCable'>
  fxGraph: DeckFxGraph | null
  displayName: string
}
interface DeckFxGraph {
  delay: NexusEntity<'stompboxDelay'>
  reverb: NexusEntity<'stompboxReverb'>
  distortion: NexusEntity<'stompboxTube'>
  flanger: NexusEntity<'stompboxFlanger'> | NexusEntity<'stompboxChorus'>
  cables: [
    NexusEntity<'desktopAudioCable'>,
    NexusEntity<'desktopAudioCable'>,
    NexusEntity<'desktopAudioCable'>,
    NexusEntity<'desktopAudioCable'>,
    NexusEntity<'desktopAudioCable'>,
  ]
}
interface DeckFxElements {
  assistant: HTMLDivElement
  view: HTMLElement
  error: HTMLDivElement
  back: HTMLButtonElement
  headerButtons: HTMLButtonElement[]
  knobs: Record<DeckFxKind, HTMLCanvasElement>
  outputs: Record<DeckFxKind, HTMLOutputElement>
}
interface DeckLibraryElements {
  assistant: HTMLDivElement
  trigger: HTMLButtonElement
  view: HTMLElement
  search: HTMLInputElement
  grid: HTMLDivElement
  list: HTMLDivElement
  count: HTMLSpanElement
  error: HTMLDivElement
  back: HTMLButtonElement
  load: HTMLButtonElement
  sortButtons: HTMLButtonElement[]
}
interface MusicLibraryPickerState {
  query: string
  sortKey: MusicLibrarySortKey
  sortDirection: MusicLibrarySortDirection
  selectedId: string | null
  expandedFolderIds: Set<string>
}
type MusicLibraryConnectionState = 'empty' | 'busy' | 'ready' | 'reconnect' | 'error'
type MusicDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}
interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  }) => Promise<MusicDirectoryHandle>
}
interface ResolvedDeckContentGraph {
  region: NexusEntity<'audioRegion'>
  sample: NexusEntity<'sample'>
  automationCollection: NexusEntity<'automationCollection'>
}
interface ReusableDeckGraph {
  routing: ResolvedDeckRoutingGraph
  content: ResolvedDeckContentGraph | null
}

const MAGIC_DURATION_BARS = 4
const MAGIC_CAPTURE_BARS = 5
const BEATS_PER_BAR = 4
const CAPTURE_SAMPLE_RATE = 48_000
const PROJECT_PRE_GAIN_BASE = 0.39810699224472046
const MIN_SUPPORTED_BPM = 40
const MAX_SUPPORTED_BPM = 240
const AUBIO_AUTO_ACCEPT_CONFIDENCE = 0.8
const DECK_PROMPT_IDLE_TEXT = 'YOUR DECK ASSISTANT IS READY'
const DECK_PROJECT_NAMES = ['DECK 1', 'DECK 2', 'MAGIC DECK'] as const
const CUE_STORAGE_PREFIX = 'magic-deck:cues:v1:'
const MUSIC_LIBRARY_DB_NAME = 'magic-deck-library'
const MUSIC_LIBRARY_STORE_NAME = 'settings'
const CUE_DATABASE_STORE_NAME = 'cue-points'
const MUSIC_LIBRARY_DB_VERSION = 2
const MUSIC_LIBRARY_ROOT_KEY = 'music-root'
const MUSIC_LIBRARY_PAGE_SIZE = 3

// ── State ─────────────────────────────────────────────────────────────────────
let at: AuthenticatedClient | null = null
let nexus: SyncedDocument | null = null
let projectConnected = false
let currentProjectId: string | null = null
let currentProjectBpm: number | null = null
let deckLoadQueue: Promise<void> = Promise.resolve()
let sourceTimingQueue: Promise<void> = Promise.resolve()
let barAssistantQueue: Promise<void> = Promise.resolve()
let activeFxDeckIndex: WaveformDeckIndex | null = null
let activeFxTrigger: HTMLButtonElement | null = null
let deckFxAssistantRequestId = 0
let activeLibraryDeckIndex: 0 | 1 | null = null
let musicLibraryDirectoryHandle: MusicDirectoryHandle | null = null
let musicLibraryEntries: MusicLibraryEntry[] = []
let musicLibraryTree: MusicLibraryNode[] = []
let musicLibraryFolderName = ''
let musicLibraryConnectionState: MusicLibraryConnectionState = 'empty'
let musicLibraryStatusMessage = 'NO MUSIC FOLDER SELECTED'
let musicLibraryUsesFallback = false
let tempoSessionId = 0
let magicWaveformPeaks: number[] | null = null
let suppressMagicProjectRemovalSync = false
let liveAudioStream: MediaStream | null = null
let liveAudioContext: AudioContext | null = null
let liveAudioSource: MediaStreamAudioSourceNode | null = null
let liveAudioWorklet: AudioWorkletNode | null = null
let liveAudioSilentGain: GainNode | null = null
let activeLiveAudioRecording: ActiveLiveAudioRecording | null = null
let liveAudioShareRequest: Promise<void> | null = null
let liveAudioSessionId = 0
let liveAudioRecordingId = 0
const pendingBpmResolutions: Array<((resolution: BpmResolution | null) => void) | null> = [null, null]
const manualBpmReportStates: [ManualBpmReportState, ManualBpmReportState] = [
  { editing: false, pending: false, requestId: 0 },
  { editing: false, pending: false, requestId: 0 },
]
const musicLibraryPickerStates: [MusicLibraryPickerState, MusicLibraryPickerState] = [
  {
    query: '', sortKey: 'name', sortDirection: 'ascending', selectedId: null,
    expandedFolderIds: new Set(),
  },
  {
    query: '', sortKey: 'name', sortDirection: 'ascending', selectedId: null,
    expandedFolderIds: new Set(),
  },
]
const deckOperationStates: [DeckOperationState, DeckOperationState, DeckOperationState] = [
  { pendingCount: 0, activeKind: null, uploading: false, suppressProjectRemovalSync: false },
  { pendingCount: 0, activeKind: null, uploading: false, suppressProjectRemovalSync: false },
  { pendingCount: 0, activeKind: null, uploading: false, suppressProjectRemovalSync: false },
]
const decks: [DeckState, DeckState, DeckState] = [
  { audioCtx: null, audioBuffer: null, cueLoadId: 0, audioFootprint: null, cuePoints: [null, null, null, null, null], cuePosition: 0, cueLoading: false, scheduledCuePosition: 0, cuePersistenceWarning: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, tempoPercent: 0, tempoRange: 10, tempoSync: false, tempoUpdatePending: false, pendingTempoPercent: null, tempoWorker: null, tempoReconcileScheduled: false, lastAppliedTiming: null, volume: 0.8, gainTrim: 1, sampleBpm: null, regionEntity: null, sampleMeta: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null, sampleEntity: null, automationCollectionEntity: null, cableEntity: null, fxGraph: null, contentSubscriptions: [], routingSubscriptions: [] },
  { audioCtx: null, audioBuffer: null, cueLoadId: 0, audioFootprint: null, cuePoints: [null, null, null, null, null], cuePosition: 0, cueLoading: false, scheduledCuePosition: 0, cuePersistenceWarning: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, tempoPercent: 0, tempoRange: 10, tempoSync: false, tempoUpdatePending: false, pendingTempoPercent: null, tempoWorker: null, tempoReconcileScheduled: false, lastAppliedTiming: null, volume: 0.8, gainTrim: 1, sampleBpm: null, regionEntity: null, sampleMeta: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null, sampleEntity: null, automationCollectionEntity: null, cableEntity: null, fxGraph: null, contentSubscriptions: [], routingSubscriptions: [] },
  { audioCtx: null, audioBuffer: null, cueLoadId: 0, audioFootprint: null, cuePoints: [null, null, null, null, null], cuePosition: 0, cueLoading: false, scheduledCuePosition: 0, cuePersistenceWarning: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, tempoPercent: 0, tempoRange: 10, tempoSync: false, tempoUpdatePending: false, pendingTempoPercent: null, tempoWorker: null, tempoReconcileScheduled: false, lastAppliedTiming: null, volume: 0.8, gainTrim: 1, sampleBpm: null, regionEntity: null, sampleMeta: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null, sampleEntity: null, automationCollectionEntity: null, cableEntity: null, fxGraph: null, contentSubscriptions: [], routingSubscriptions: [] },
]

const guardedRegionRemovalIds = new Set<string>()

const knobState: Map<HTMLCanvasElement, { value: number; dragging: boolean; startY: number; startVal: number }> = new Map()

// ── DOM ───────────────────────────────────────────────────────────────────────
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
function requiredElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`Missing required element: ${selector}`)
  return element
}
function getDeckFxElements(deckIndex: WaveformDeckIndex): DeckFxElements {
  const assistant = requiredElement<HTMLDivElement>(
    document,
    `[data-deck-assistant="${deckIndex}"]`,
  )
  const view = requiredElement<HTMLElement>(assistant, '[data-deck-fx-view]')
  const knobs = {} as Record<DeckFxKind, HTMLCanvasElement>
  const outputs = {} as Record<DeckFxKind, HTMLOutputElement>
  DECK_FX_KINDS.forEach((kind) => {
    knobs[kind] = requiredElement<HTMLCanvasElement>(view, `[data-fx="${kind}"]`)
    outputs[kind] = requiredElement<HTMLOutputElement>(view, `[data-fx-value="${kind}"]`)
  })
  return {
    assistant,
    view,
    error: requiredElement<HTMLDivElement>(view, '[data-deck-fx-error]'),
    back: requiredElement<HTMLButtonElement>(view, '[data-deck-fx-back]'),
    headerButtons: Array.from(
      assistant.querySelectorAll<HTMLButtonElement>('.bpm-dialogue-header-actions button'),
    ),
    knobs,
    outputs,
  }
}
function getDeckLibraryElements(deckIndex: 0 | 1): DeckLibraryElements {
  const assistant = requiredElement<HTMLDivElement>(
    document,
    `[data-deck-assistant="${deckIndex}"]`,
  )
  const view = requiredElement<HTMLElement>(assistant, '[data-deck-library-view]')
  return {
    assistant,
    trigger: requiredElement<HTMLButtonElement>(assistant, `[data-deck-library="${deckIndex}"]`),
    view,
    search: requiredElement<HTMLInputElement>(view, '[data-deck-library-search]'),
    grid: requiredElement<HTMLDivElement>(view, '[data-deck-library-grid]'),
    list: requiredElement<HTMLDivElement>(view, '[data-deck-library-list]'),
    count: requiredElement<HTMLSpanElement>(view, '[data-deck-library-count]'),
    error: requiredElement<HTMLDivElement>(view, '[data-deck-library-error]'),
    back: requiredElement<HTMLButtonElement>(view, '[data-deck-library-back]'),
    load: requiredElement<HTMLButtonElement>(view, '[data-deck-library-load]'),
    sortButtons: Array.from(view.querySelectorAll<HTMLButtonElement>('[data-library-sort]')),
  }
}
const statusDot = el<HTMLSpanElement>('status-dot')
const statusText = el<HTMLSpanElement>('status-text')
const statusUser = el<HTMLDivElement>('status-user')
const btnLogin = el<HTMLButtonElement>('btn-login')
const btnConnect = el<HTMLButtonElement>('btn-connect')
const btnDisconnect = el<HTMLButtonElement>('btn-disconnect')
const projectUrlRow = el<HTMLDivElement>('project-url-row')
const audioCaptureRow = el<HTMLDivElement>('audio-capture-row')
const btnOpenAudiotool = el<HTMLButtonElement>('btn-open-audiotool')
const btnAudioCapture = el<HTMLButtonElement>('btn-audio-capture')
const audioCaptureDot = el<HTMLSpanElement>('audio-capture-dot')
const audioCaptureLabel = el<HTMLSpanElement>('audio-capture-label')
const musicLibraryDot = el<HTMLSpanElement>('music-library-dot')
const musicLibraryStatus = el<HTMLSpanElement>('music-library-status')
const btnMusicLibraryChoose = el<HTMLButtonElement>('btn-music-library-choose')
const btnMusicLibraryRefresh = el<HTMLButtonElement>('btn-music-library-refresh')
const btnMusicLibraryChange = el<HTMLButtonElement>('btn-music-library-change')
const musicLibraryFallbackInput = el<HTMLInputElement>('music-library-fallback')
const inputProjectUrl = el<HTMLInputElement>('input-project-url')
const magentaUrl = el<HTMLInputElement>('magenta-url')
const btnGenerate = el<HTMLButtonElement>('btn-generate')
const magicDot = el<HTMLSpanElement>('magic-dot')
const magicStatusLabel = el<HTMLSpanElement>('magic-status-label')
const magicPrompt = el<HTMLInputElement>('magic-prompt')
const magicStemRoleInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="magic-stem-role"]'),
)
const magicWaveform = el<HTMLCanvasElement>('magic-waveform')

// ── Music library ────────────────────────────────────────────────────────────
function openMusicLibraryDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MUSIC_LIBRARY_DB_NAME, MUSIC_LIBRARY_DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MUSIC_LIBRARY_STORE_NAME)) {
        request.result.createObjectStore(MUSIC_LIBRARY_STORE_NAME)
      }
      if (!request.result.objectStoreNames.contains(CUE_DATABASE_STORE_NAME)) {
        request.result.createObjectStore(CUE_DATABASE_STORE_NAME, { keyPath: 'audioFootprint' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Music library database failed'))
    request.onblocked = () => reject(new Error('Music library database upgrade was blocked'))
  })
}

async function loadStoredMusicDirectoryHandle(): Promise<MusicDirectoryHandle | null> {
  const database = await openMusicLibraryDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(MUSIC_LIBRARY_STORE_NAME, 'readonly')
        .objectStore(MUSIC_LIBRARY_STORE_NAME)
        .get(MUSIC_LIBRARY_ROOT_KEY)
      request.onsuccess = () => resolve((request.result as MusicDirectoryHandle | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('Stored music folder could not be read'))
    })
  } finally {
    database.close()
  }
}

async function storeMusicDirectoryHandle(handle: MusicDirectoryHandle) {
  const database = await openMusicLibraryDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(MUSIC_LIBRARY_STORE_NAME, 'readwrite')
        .objectStore(MUSIC_LIBRARY_STORE_NAME)
        .put(handle, MUSIC_LIBRARY_ROOT_KEY)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error ?? new Error('Music folder could not be remembered'))
    })
  } finally {
    database.close()
  }
}

function directoryPickerAvailable() {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

function renderMusicLibrarySetup() {
  musicLibraryDot.className = `dot ${musicLibraryConnectionState === 'ready'
    ? 'connected'
    : musicLibraryConnectionState === 'busy'
      ? 'connecting'
      : musicLibraryConnectionState === 'error'
        ? 'error'
        : 'idle'}`
  musicLibraryStatus.textContent = musicLibraryStatusMessage
  const ready = musicLibraryConnectionState === 'ready'
  const reconnect = musicLibraryConnectionState === 'reconnect'
  const busy = musicLibraryConnectionState === 'busy'
  btnMusicLibraryChoose.classList.toggle('is-hidden', ready)
  btnMusicLibraryChoose.textContent = reconnect ? 'RECONNECT' : 'CHOOSE FOLDER'
  btnMusicLibraryChoose.disabled = busy
  btnMusicLibraryRefresh.classList.toggle('is-hidden', !ready)
  btnMusicLibraryRefresh.textContent = musicLibraryUsesFallback ? 'RESELECT' : 'REFRESH'
  btnMusicLibraryRefresh.disabled = busy
  btnMusicLibraryChange.classList.toggle('is-hidden', !ready && !reconnect)
  btnMusicLibraryChange.disabled = busy
  if (activeLibraryDeckIndex !== null) renderDeckLibraryView(activeLibraryDeckIndex)
  renderDeckLibraryAvailability()
}

function setMusicLibrarySetupState(
  state: MusicLibraryConnectionState,
  message: string,
) {
  musicLibraryConnectionState = state
  musicLibraryStatusMessage = message
  renderMusicLibrarySetup()
}

function updateMusicLibraryIndex(entries: MusicLibraryEntry[]) {
  musicLibraryEntries = entries
  musicLibraryTree = buildMusicLibraryTree(entries)
  for (const state of musicLibraryPickerStates) {
    for (const folderId of state.expandedFolderIds) {
      if (findMusicLibraryNode(musicLibraryTree, folderId)?.kind !== 'folder') {
        state.expandedFolderIds.delete(folderId)
      }
    }
  }
}

async function scanMusicDirectory(handle: MusicDirectoryHandle) {
  setMusicLibrarySetupState('busy', `INDEXING ${handle.name.toUpperCase()}…`)
  try {
    const entries = await indexMusicDirectory(handle)
    musicLibraryDirectoryHandle = handle
    musicLibraryFolderName = handle.name
    updateMusicLibraryIndex(entries)
    musicLibraryUsesFallback = false
    setMusicLibrarySetupState(
      'ready',
      `${handle.name.toUpperCase()} · ${entries.length} ${entries.length === 1 ? 'TRACK' : 'TRACKS'}`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setMusicLibrarySetupState('error', `INDEX FAILED · ${message.toUpperCase()}`)
  }
}

async function chooseMusicDirectory() {
  if (!directoryPickerAvailable()) {
    musicLibraryFallbackInput.value = ''
    musicLibraryFallbackInput.click()
    return
  }
  try {
    const handle = await (window as DirectoryPickerWindow).showDirectoryPicker!({
      id: 'magic-deck-music-library',
      mode: 'read',
      startIn: 'music',
    })
    try {
      await storeMusicDirectoryHandle(handle)
    } catch (error) {
      console.warn('[MUSIC LIBRARY] Folder handle will be available for this session only:', error)
    }
    await scanMusicDirectory(handle)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    const message = error instanceof Error ? error.message : String(error)
    setMusicLibrarySetupState('error', `FOLDER SELECTION FAILED · ${message.toUpperCase()}`)
  }
}

async function reconnectMusicDirectory() {
  const handle = musicLibraryDirectoryHandle
  if (!handle) {
    await chooseMusicDirectory()
    return
  }
  try {
    const permission = await handle.requestPermission({ mode: 'read' })
    if (permission !== 'granted') {
      setMusicLibrarySetupState('reconnect', `${handle.name.toUpperCase()} · ACCESS REQUIRED`)
      return
    }
    await scanMusicDirectory(handle)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setMusicLibrarySetupState('error', `RECONNECT FAILED · ${message.toUpperCase()}`)
  }
}

async function refreshMusicLibrary() {
  if (musicLibraryUsesFallback) {
    musicLibraryFallbackInput.value = ''
    musicLibraryFallbackInput.click()
    return
  }
  if (!musicLibraryDirectoryHandle) {
    await chooseMusicDirectory()
    return
  }
  const permission = await musicLibraryDirectoryHandle.queryPermission({ mode: 'read' })
  if (permission !== 'granted') {
    await reconnectMusicDirectory()
    return
  }
  await scanMusicDirectory(musicLibraryDirectoryHandle)
}

async function restoreMusicLibrary() {
  if (!directoryPickerAvailable()) {
    renderMusicLibrarySetup()
    return
  }
  try {
    const handle = await loadStoredMusicDirectoryHandle()
    if (!handle) {
      renderMusicLibrarySetup()
      return
    }
    musicLibraryDirectoryHandle = handle
    musicLibraryFolderName = handle.name
    const permission = await handle.queryPermission({ mode: 'read' })
    if (permission === 'granted') {
      await scanMusicDirectory(handle)
    } else {
      setMusicLibrarySetupState('reconnect', `${handle.name.toUpperCase()} · ACCESS REQUIRED`)
    }
  } catch (error) {
    console.warn('[MUSIC LIBRARY] Stored folder could not be restored:', error)
    renderMusicLibrarySetup()
  }
}

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(state: 'idle' | 'connecting' | 'connected' | 'error', msg: string) {
  statusDot.className = `dot ${state}`
  statusText.textContent = msg
  console.log(`[STATUS] ${state}: ${msg}`)
}
function setMagicStatus(state: 'idle' | 'generating' | 'error' | 'done' | 'warning', label: string) {
  magicDot.className = `status-dot-magic ${state}`
  magicStatusLabel.textContent = label
}

function placementDeckLabel(deckIndex: WaveformDeckIndex) {
  if (deckIndex === 0) return 'Deck A'
  if (deckIndex === 1) return 'Deck B'
  return 'Magic Deck'
}

function requestExtensionTransportPosition(
  projectId: string,
  deckIndex: WaveformDeckIndex,
): Promise<TransportPosition | null> {
  const requestId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const request: TransportRequest = {
    channel: TRANSPORT_CHANNEL,
    type: 'request',
    requestId,
    projectId,
    deckIndex,
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: TransportPosition | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      window.removeEventListener('message', onMessage)
      resolve(result)
    }
    const onMessage = (event: MessageEvent<TransportResponse>) => {
      if (event.source !== window || event.origin !== window.location.origin) return
      const validation = validateTransportResponse(event.data, request)
      if (!validation.ok) {
        if (
          event.data?.channel === TRANSPORT_CHANNEL
          && event.data?.type === 'response'
          && event.data?.requestId === requestId
        ) finish(null)
        return
      }
      finish(validation.position)
    }
    const timeoutId = window.setTimeout(() => finish(null), TRANSPORT_REQUEST_TIMEOUT_MS)
    window.addEventListener('message', onMessage)
    window.postMessage(request, window.location.origin)
  })
}

type BarAssistantPurpose = 'placement' | 'cue-launch' | 'reenter-launch' | 'stop' | 'cancel-check'

interface BarAssistantContext {
  cueNumber?: number
  cuePosition?: number
  cueSourceBar?: number
}

function currentDeckRegionPositionTicks(deckIndex: WaveformDeckIndex) {
  const projectDocument = nexus
  const controlledRegion = decks[deckIndex].regionEntity
  if (!projectDocument || !controlledRegion) return 0
  const currentRegion = projectDocument.queryEntities
    .ofTypes('audioRegion')
    .getEntity(controlledRegion.id)
  if (!currentRegion) return 0
  return contiguousAudioRegions(projectDocument.queryEntities, currentRegion)[0]
    ?.fields.region.fields.positionTicks.value
    ?? currentRegion.fields.region.fields.positionTicks.value
}

function showBarAssistantNow(
  deckIndex: WaveformDeckIndex,
  purpose: BarAssistantPurpose,
  context: BarAssistantContext = {},
): Promise<number | null> {
  if (activeFxDeckIndex !== null) closeDeckFxAssistant()
  if (activeLibraryDeckIndex !== null) closeDeckLibraryAssistant(false)
  return new Promise((resolve) => {
    const deckNumber = deckIndex + 1
    const assistant = el<HTMLDivElement>(
      deckIndex < 2 ? `deck${deckNumber}-bpm-dialogue` : `deck${deckNumber}-assistant`,
    )
    const form = el<HTMLDivElement>(`deck${deckNumber}-bar-assistant`)
    const title = el<HTMLDivElement>(`deck${deckNumber}-bar-assistant-title`)
    const copy = el<HTMLParagraphElement>(`deck${deckNumber}-bar-assistant-copy`)
    const input = el<HTMLInputElement>(`deck${deckNumber}-bar-assistant-input`)
    const error = el<HTMLDivElement>(`deck${deckNumber}-bar-assistant-error`)
    const confirm = el<HTMLButtonElement>(`deck${deckNumber}-bar-assistant-confirm`)
    const cancel = el<HTMLButtonElement>(`deck${deckNumber}-bar-assistant-cancel`)
    const label = placementDeckLabel(deckIndex)

    const assistantCopy: Record<BarAssistantPurpose, { title: string; copy: string; confirm: string; cancel: string }> = {
      placement: {
        title: `Choose ${label} Insertion Bar`,
        copy: `The Audiotool transport could not be read automatically. Enter the whole-number bar currently displayed in Studio. ${label} will be placed at the beginning of that bar.`,
        confirm: 'PLACE AT BAR',
        cancel: 'CANCEL LOAD',
      },
      'cue-launch': {
        title: `Schedule ${label} Cue ${context.cueNumber ?? ''}`.trim(),
        copy: `Cue ${context.cueNumber ?? ''} starts at source bar ${context.cueSourceBar ?? '—'} (${context.cuePosition === undefined ? '—' : formatCueTime(deckIndex, context.cuePosition)}). Enter the exact whole-number Audiotool bar where its remaining audio should begin.`,
        confirm: 'SCHEDULE CUE',
        cancel: 'CANCEL',
      },
      'reenter-launch': {
        title: `Re-enter ${label} Launch Bar`,
        copy: `Enter the exact whole-number Audiotool bar where the full ${label} track should begin.`,
        confirm: 'SCHEDULE FULL TRACK',
        cancel: 'CANCEL',
      },
      stop: {
        title: `Choose ${label} Stop Bar`,
        copy: 'Automatic transport capture is unavailable. Enter the future whole-number bar where this deck should stop.',
        confirm: 'STOP AT BAR',
        cancel: 'CANCEL',
      },
      'cancel-check': {
        title: `Confirm ${label} Current Bar`,
        copy: 'Automatic transport capture is unavailable. Enter the whole-number bar currently displayed in Audiotool so Deck Assistant can confirm the launch has not begun.',
        confirm: 'CHECK & CANCEL',
        cancel: 'KEEP LAUNCH',
      },
    }
    const content = assistantCopy[purpose]
    title.textContent = content.title
    copy.textContent = content.copy
    confirm.textContent = content.confirm
    cancel.textContent = content.cancel
    input.value = String(tickToBar(currentDeckRegionPositionTicks(deckIndex), Ticks.Bars(1)))
    error.textContent = ''
    assistant.classList.remove('is-hidden')
    assistant.classList.add('bar-assistant-active')
    form.classList.remove('is-hidden')
    assistant.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    input.focus()
    input.select()

    const close = (bar: number | null) => {
      form.classList.add('is-hidden')
      assistant.classList.remove('bar-assistant-active')
      if (deckIndex === 2) assistant.classList.add('is-hidden')
      confirm.onclick = null
      cancel.onclick = null
      input.oninput = null
      document.removeEventListener('keydown', onKey)
      resolve(bar)
    }
    const submit = () => {
      const bar = Number(input.value.trim())
      if (!Number.isSafeInteger(bar) || bar < 1) {
        error.textContent = 'ENTER A WHOLE-NUMBER BAR OF 1 OR GREATER'
        input.focus()
        input.select()
        return
      }
      close(bar)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(null)
      if (event.key === 'Enter' && event.target === input) {
        event.preventDefault()
        submit()
      }
    }

    confirm.onclick = submit
    cancel.onclick = () => close(null)
    input.oninput = () => { error.textContent = '' }
    document.addEventListener('keydown', onKey)
  })
}

function showBarAssistant(
  deckIndex: WaveformDeckIndex,
  purpose: BarAssistantPurpose,
  context: BarAssistantContext = {},
) {
  const queued = barAssistantQueue.then(() => showBarAssistantNow(deckIndex, purpose, context))
  barAssistantQueue = queued.then(() => undefined, () => undefined)
  return queued
}

function showPlacementAssistant(deckIndex: WaveformDeckIndex) {
  return showBarAssistant(deckIndex, 'placement')
}

function projectHasTimelineContent(entities: EntityQuery) {
  return entities
    .ofTypes('audioRegion', 'noteRegion', 'patternRegion', 'automationRegion')
    .get()
    .length > 0
}

function projectHasLoadedTimelineContent(projectDocument: SyncedDocument) {
  return projectHasTimelineContent(projectDocument.queryEntities)
}

async function captureDeckInsertionPlacement(
  deckIndex: WaveformDeckIndex,
): Promise<DeckInsertionPlacement | null> {
  const projectDocument = nexus
  if (!projectConnected || !projectDocument) {
    throw new Error('Connect an Audiotool project before loading audio')
  }
  if (!projectHasLoadedTimelineContent(projectDocument)) {
    const placement: DeckInsertionPlacement = {
      deckIndex,
      bar: 1,
      positionTicks: Ticks.Bars(0),
      source: 'project-start',
      capturedAt: Date.now(),
    }
    return placement
  }
  const projectId = currentProjectId
  const extensionCapture = projectId
    ? await requestExtensionTransportPosition(projectId, deckIndex)
    : null
  if (nexus !== projectDocument || !projectConnected) {
    throw new Error('Project connection changed during placement capture')
  }
  const bar = extensionCapture?.bar ?? await showPlacementAssistant(deckIndex)
  if (bar === null) return null
  if (nexus !== projectDocument || !projectConnected) {
    throw new Error('Project connection changed during manual placement')
  }
  const placement: DeckInsertionPlacement = {
    deckIndex,
    bar,
    positionTicks: barToPositionTicks(bar, Ticks.Bars(1)),
    source: extensionCapture ? 'extension' : 'manual',
    capturedAt: extensionCapture?.capturedAt ?? Date.now(),
  }
  return placement
}

// ── AUTH — based on the minimal example ──────────────────────────────────────
function cleanStaleOAuthCallback() {
  const expectedState = localStorage.getItem(OAUTH_STATE_STORAGE_KEY)
  const cleanedUrl = staleOAuthCallbackUrl(window.location.href, expectedState)
  if (cleanedUrl === null) return

  console.warn('[AUTH] Removing stale OAuth callback parameters')
  window.history.replaceState(window.history.state, document.title, cleanedUrl)
}

async function init() {
  setStatus('connecting', 'CHECKING AUTH STATE…')
  console.log('[INIT] Calling audiotool()…')

  try {
    cleanStaleOAuthCallback()
    const result = await audiotool({
      clientId: CLIENT_ID,
      redirectUrl: REDIRECT_URL,
      scope: SCOPE,
    })

    console.log('[INIT] audiotool() returned:', result.status)

    if (result.status === 'authenticated') {
      at = result
      statusUser.textContent = result.userName.toUpperCase()
      setStatus('connected', `AUTHENTICATED AS ${result.userName.toUpperCase()}`)
      btnLogin.style.display = 'none'
      projectUrlRow.style.display = 'flex'
      audioCaptureRow.style.display = 'flex'
      btnConnect.disabled = false
      btnDisconnect.disabled = false
      if (inputProjectUrl.value.trim()) {
        await connectProject()
      }
    } else {
      btnLogin.style.display = ''
      btnLogin.disabled = false
      if (result.error) {
        setStatus('error', `AUTH ERROR: ${result.error.message}`)
      } else {
        setStatus('idle', 'CLICK LOGIN TO CONNECT TO AUDIOTOOL')
      }
      btnLogin.onclick = () => {
        setStatus('connecting', 'REDIRECTING TO AUDIOTOOL…')
        result.login()
      }
    }
  } catch (e: unknown) {
    console.error('[INIT] Error:', e)
    setStatus('error', `INIT FAILED: ${e instanceof Error ? e.message : String(e)}`)
    btnLogin.disabled = false
  }
}

async function disconnectAll() {
  resetTempoMasterSession()
  await stopLiveAudioCapture()
  if (nexus) { try { await nexus.stop() } catch (_) {}; nexus = null }
  projectConnected = false
  if (at) { try { at.logout() } catch (_) {}; at = null }
  decks.forEach(clearDeckProjectEntities)
  clearMagicDeckLocalMedia()
  updateSourceDeckUi(0)
  updateSourceDeckUi(1)
  statusUser.textContent = ''
  projectUrlRow.style.display = 'none'
  audioCaptureRow.style.display = 'none'
  btnLogin.style.display = ''
  btnConnect.disabled = true
  btnDisconnect.disabled = true
  setStatus('idle', 'DISCONNECTED — CLICK LOGIN TO RECONNECT')
  init()
}

// ── PROJECT ───────────────────────────────────────────────────────────────────
function showCreateProjectModal(): Promise<{ name: string; description: string } | null> {
  return new Promise((resolve) => {
    const modal = el<HTMLDivElement>('create-modal')
    const nameInput = el<HTMLInputElement>('modal-project-name')
    const descInput = el<HTMLTextAreaElement>('modal-project-description')
    const btnConfirm = el<HTMLButtonElement>('modal-confirm')
    const btnCancel = el<HTMLButtonElement>('modal-cancel')

    modal.classList.remove('is-hidden')
    nameInput.focus()
    nameInput.select()

    const close = (result: { name: string; description: string } | null) => {
      modal.classList.add('is-hidden')
      btnConfirm.onclick = null
      btnCancel.onclick = null
      document.removeEventListener('keydown', onKey)
      resolve(result)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null)
      if (e.key === 'Enter' && e.target === nameInput) {
        e.preventDefault()
        btnConfirm.click()
      }
    }

    btnConfirm.onclick = () => {
      const name = nameInput.value.trim()
      if (!name) { nameInput.focus(); return }
      close({ name, description: descInput.value.trim() })
    }
    btnCancel.onclick = () => close(null)
    document.addEventListener('keydown', onKey)
  })
}

async function createNewProject() {
  if (!at) { setStatus('error', 'NOT LOGGED IN'); return }
  const result = await showCreateProjectModal()
  if (!result) return
  setStatus('connecting', `CREATING PROJECT "${result.name}"…`)
  try {
    const response = await at.projects.createProject({
      project: { displayName: result.name, description: result.description || 'Created from NEXUS DJ' },
    })
    if (response instanceof Error) throw response
    const project = response.project
    if (!project) throw new Error('No project returned')

    const uuid = project.name.replace(/^projects\//, '')
    const url = `https://beta.audiotool.com/studio?project=${uuid}`
    inputProjectUrl.value = url
    localStorage.setItem('nexus_project_url', url)
    setStatus('connected', `PROJECT "${result.name}" CREATED — CLICK CONNECT PROJECT`)
  } catch (e: unknown) {
    setStatus('error', `CREATE FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function connectProject() {
  if (!at) { setStatus('error', 'NOT LOGGED IN'); return }
  const projectUrl = inputProjectUrl.value.trim()
  if (!projectUrl) { setStatus('error', 'PASTE AN AUDIOTOOL PROJECT URL ABOVE'); return }
  const projectId = projectIdFromUrl(projectUrl)
  if (!projectId) { setStatus('error', 'AUDIOTOOL PROJECT URL DOES NOT CONTAIN A PROJECT ID'); return }
  setStatus('connecting', 'OPENING PROJECT…')
  btnConnect.disabled = true
  resetTempoMasterSession()
  for (const deckIndex of [0, 1] as const) {
    clearSourceDeckLocalMedia(deckIndex)
    clearDeckProjectEntities(decks[deckIndex])
    updateSourceDeckUi(deckIndex)
  }
  clearMagicDeckLocalMedia()
  clearDeckProjectEntities(decks[2])
  try {
    nexus = await at.open(projectUrl)
    currentProjectId = projectId
    const projectDocument = nexus
    const expectedSession = tempoSessionId
    projectDocument.connected.subscribe((connected) => {
      if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
      projectConnected = connected
      if (connected) {
        resetDeckCuePosition(0)
        resetDeckCuePosition(1)
        updateSourceDeckUi(0)
        updateSourceDeckUi(1)
      } else {
        resetManualBpmReport(0)
        resetManualBpmReport(1)
        updateSourceDeckUi(0)
        updateSourceDeckUi(1)
      }
      renderDeckFxAvailability()
      decks.forEach((_, deckIndex) => renderTempoControls(deckIndex as WaveformDeckIndex))
      decks.forEach((_, deckIndex) => renderDeckTransport(deckIndex as WaveformDeckIndex))
      setStatus(connected ? 'connected' : 'error', connected ? 'SYNCED ↔ PROJECT ACTIVE' : 'CONNECTION LOST…')
    })
    loadBPM()
    await nexus.start()
    if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
    projectConnected = projectDocument.connected.getValue()
    if (!projectConnected) throw new Error('Project connection was lost after initial sync')
    renderDeckFxAvailability()
    await reconcileDecksFromProject(projectDocument, expectedSession)
    updateSourceDeckUi(0)
    updateSourceDeckUi(1)
    setStatus('connected', 'SYNCED ↔ PROJECT ACTIVE')
    localStorage.setItem('nexus_project_url', projectUrl)
  } catch (e: unknown) {
    setStatus('error', `PROJECT ERROR: ${e instanceof Error ? e.message : String(e)}`)
    nexus = null
    projectConnected = false
    currentProjectId = null
    btnConnect.disabled = false
    renderDeckFxAvailability()
  }
}

function resetTempoMasterSession() {
  if (activeLibraryDeckIndex !== null) closeDeckLibraryAssistant(false)
  tempoSessionId += 1
  projectConnected = false
  currentProjectId = null
  currentProjectBpm = null
  renderDeckFxAvailability()
  decks.forEach((_, deckIndex) => resetDeckTempoState(deckIndex as WaveformDeckIndex))
  pendingBpmResolutions.forEach((resolve, deckIndex) => {
    resolve?.(null)
    pendingBpmResolutions[deckIndex] = null
    resetBpmDialogue(deckIndex)
  })
  resetManualBpmReport(0)
  resetManualBpmReport(1)
  updateSourceDeckUi(0)
  updateSourceDeckUi(1)
  decks.forEach((_, deckIndex) => renderDeckTransport(deckIndex as WaveformDeckIndex))
}

// ── NEXUS ─────────────────────────────────────────────────────────────────────
function updateDeckBpmLabels(bpm: number | null) {
  const normalizedBpm = normalizeBpm(bpm)
  currentProjectBpm = normalizedBpm
  decks.forEach((deck, index) => {
    if (deck.sampleBpm === null) deck.baseBpm = normalizedBpm
    renderTempoControls(index as WaveformDeckIndex)
  })
  updateLiveAudioShareStatus()
}
function updateDeckBpmLabel(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  if (!canUseDeckTempo(deckIndex)) {
    el(`deck${deckIndex + 1}-bpm`).textContent = '—'
    return
  }
  const sourceBpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
  const bpm = sourceBpm === null ? null : effectiveBpm(sourceBpm, deck.tempoPercent)
  el(`deck${deckIndex + 1}-bpm`).textContent =
    bpm === null ? '—' : bpm.toFixed(2).replace(/\.?0+$/, '')
}

function canUseDeckTempo(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  return projectConnected
    && nexus !== null
    && isSupportedBpm(currentProjectBpm)
    && isSupportedBpm(normalizeBpm(deck.sampleBpm ?? deck.baseBpm))
    && deck.sampleMeta !== null
    && deck.regionEntity !== null
    && deck.automationCollectionEntity !== null
}

function resetDeckTempoState(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  deck.tempoPercent = 0
  deck.tempoRange = 10
  deck.tempoSync = false
  deck.tempoUpdatePending = false
  deck.pendingTempoPercent = null
  deck.tempoWorker = null
  deck.tempoReconcileScheduled = false
  deck.lastAppliedTiming = null
  deck.playbackRate = 1
  renderTempoControls(deckIndex)
}

function getTempoElements(deckIndex: WaveformDeckIndex) {
  const prefix = `d${deckIndex + 1}-tempo`
  const module = el<HTMLDivElement>(`${prefix}-module`)
  return {
    module,
    fader: el<HTMLInputElement>(prefix),
    value: el<HTMLOutputElement>(`${prefix}-value`),
    sync: el<HTMLButtonElement>(`${prefix}-sync`),
    maximum: el<HTMLSpanElement>(`${prefix}-max`),
    minimum: el<HTMLSpanElement>(`${prefix}-min`),
    error: el<HTMLDivElement>(`${prefix}-error`),
    ranges: Array.from(module.querySelectorAll<HTMLButtonElement>('.tempo-ranges button')),
  }
}

function formatTempoPercent(percent: number) {
  const rounded = Math.abs(percent) < 0.0005 ? 0 : percent
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}%`
}

function renderTempoControls(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const controls = getTempoElements(deckIndex)
  const enabled = canUseDeckTempo(deckIndex)
  controls.fader.min = String(-deck.tempoRange)
  controls.fader.max = String(deck.tempoRange)
  controls.fader.value = String(clampTempoPercent(deck.tempoPercent, deck.tempoRange))
  controls.value.value = formatTempoPercent(deck.tempoPercent)
  controls.value.textContent = formatTempoPercent(deck.tempoPercent)
  controls.maximum.textContent = `+${deck.tempoRange}`
  controls.minimum.textContent = `−${deck.tempoRange}`
  controls.sync.classList.toggle('active', deck.tempoSync)
  controls.sync.setAttribute('aria-pressed', String(deck.tempoSync))
  controls.module.classList.toggle('is-pending', deck.tempoUpdatePending)
  controls.module.setAttribute('aria-busy', String(deck.tempoUpdatePending))
  controls.fader.disabled = !enabled
  controls.sync.disabled = !enabled
  controls.ranges.forEach((button) => {
    const selected = Number(button.dataset.range) === deck.tempoRange
    button.classList.toggle('active', selected)
    button.setAttribute('aria-pressed', String(selected))
    button.disabled = !enabled
  })
  updateDeckBpmLabel(deckIndex)
}

function setTempoError(deckIndex: WaveformDeckIndex, message: string) {
  getTempoElements(deckIndex).error.textContent = message.toUpperCase()
}

function clearTempoError(deckIndex: WaveformDeckIndex) {
  getTempoElements(deckIndex).error.textContent = ''
}

function setupTempoControls(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const controls = getTempoElements(deckIndex)
  controls.fader.addEventListener('input', () => {
    if (!canUseDeckTempo(deckIndex)) return
    deck.tempoSync = false
    deck.tempoPercent = clampTempoPercent(Number(controls.fader.value), deck.tempoRange)
    deck.playbackRate = tempoPercentToPlaybackRate(deck.tempoPercent)
    clearTempoError(deckIndex)
    renderTempoControls(deckIndex)
    queueDeckTempoUpdate(deckIndex, deck.tempoPercent)
  })
  controls.sync.addEventListener('click', () => {
    if (!canUseDeckTempo(deckIndex)) return
    if (deck.tempoSync) {
      deck.tempoSync = false
      clearTempoError(deckIndex)
      renderTempoControls(deckIndex)
      return
    }
    const sourceBpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
    const projectBpm = normalizeBpm(currentProjectBpm)
    if (!isSupportedBpm(sourceBpm) || !isSupportedBpm(projectBpm)) return
    const percent = tempoPercentForBpm(sourceBpm, projectBpm)
    const range = smallestTempoRange(percent)
    if (range === null) {
      setTempoError(deckIndex, 'SYNC TARGET EXCEEDS ±50%')
      setStatus('error', `DECK ${deckIndex + 1}: SYNC TARGET EXCEEDS THE ±50% TEMPO RANGE`)
      return
    }
    deck.tempoSync = true
    deck.tempoRange = range
    deck.tempoPercent = percent
    deck.playbackRate = tempoPercentToPlaybackRate(percent)
    clearTempoError(deckIndex)
    renderTempoControls(deckIndex)
    queueDeckTempoUpdate(deckIndex, percent)
  })
  controls.ranges.forEach((button) => {
    button.addEventListener('click', () => {
      if (!canUseDeckTempo(deckIndex)) return
      const range = Number(button.dataset.range) as TempoRange
      if (range !== 10 && range !== 30 && range !== 50) return
      deck.tempoRange = range
      const clamped = clampTempoPercent(deck.tempoPercent, range)
      const changed = Math.abs(clamped - deck.tempoPercent) > 1e-9
      if (changed) {
        deck.tempoSync = false
        deck.tempoPercent = clamped
        deck.playbackRate = tempoPercentToPlaybackRate(clamped)
      }
      clearTempoError(deckIndex)
      renderTempoControls(deckIndex)
      if (changed) queueDeckTempoUpdate(deckIndex, clamped)
    })
  })
  renderTempoControls(deckIndex)
}

function serializeSourceTiming<T>(task: () => Promise<T>): Promise<T> {
  const queued = sourceTimingQueue.then(task, task)
  sourceTimingQueue = queued.then(() => undefined, () => undefined)
  return queued
}

function reportSourceTimingError(message: string) {
  decks.slice(0, 2).forEach((deck, deckIndex) => {
    if (deck.regionEntity) {
      getManualBpmReportElements(deckIndex as 0 | 1).error.textContent =
        `TEMPO REMAP FAILED: ${message.toUpperCase()}`
    }
  })
  setStatus('error', `SOURCE TEMPO REMAP FAILED — ${message}`)
}

function scheduleProjectTempoRemap(
  projectDocument: SyncedDocument,
  projectBpm: number,
  expectedSession: number,
) {
  currentProjectBpm = projectBpm
  decks.forEach((_, deckIndex) => renderTempoControls(deckIndex as WaveformDeckIndex))
  void serializeSourceTiming(async () => {
    if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
    try {
      const result = await remapLoadedSourceRegions(
        projectDocument,
        projectBpm,
        expectedSession,
      )
      if (!result.applied) return
      if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
      updateDeckBpmLabels(projectBpm)
      result.rejected.forEach((deckIndex) => {
        setTempoError(deckIndex, 'SYNC TARGET EXCEEDS ±50%')
        setStatus(
          'error',
          `DECK ${deckIndex + 1}: PROJECT TEMPO CHANGED, BUT THE SYNC TARGET EXCEEDS ±50%`,
        )
      })
    } catch (error) {
      if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
      const message = error instanceof Error ? error.message : String(error)
      reportSourceTimingError(message)
    }
  })
}

function loadBPM() {
  const projectDocument = nexus
  const expectedSession = tempoSessionId
  if (!projectDocument) return
  let initialTempoReceived = false
  projectDocument.events.onCreate('config', (cfg) => {
    projectDocument.events.onUpdate(cfg.fields.tempoBpm, (bpm) => {
      if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
      const nextBpm = Number(bpm)
      if (
        !Number.isFinite(nextBpm)
        || nextBpm < MIN_SUPPORTED_BPM
        || nextBpm > MAX_SUPPORTED_BPM
      ) {
        reportSourceTimingError('Project BPM is outside the supported range')
        return
      }
      if (!initialTempoReceived) {
        initialTempoReceived = true
        updateDeckBpmLabels(nextBpm)
        return
      }
      scheduleProjectTempoRemap(projectDocument, nextBpm, expectedSession)
    }, true)
  })
}

function deckIndexFromDisplayName(displayName: string): WaveformDeckIndex | null {
  if (/^\s*DECK\s+1(?=$|\s|[—–-])/i.test(displayName)) return 0
  if (/^\s*DECK\s+2(?=$|\s|[—–-])/i.test(displayName)) return 1
  if (/^\s*MAGIC\s+DECK(?=$|\s|[—–-])/i.test(displayName)) return 2
  return null
}

function resolveDeckRoutingGraphs(
  entities: EntityQuery,
  audioDevice: NexusEntity<'audioDevice'>,
): ResolvedDeckRoutingGraph[] {
  const cables = entities.ofTypes('desktopAudioCable').get()
  const outputCables = cables
    .filter((candidate) =>
      candidate.fields.fromSocket.value.equals(audioDevice.fields.audioOutput.location))
  const directCableAndMixers = outputCables
    .map((cable) => ({
      cable,
      mixerChannel: entities
        .ofTypes('mixerChannel')
        .getEntity(cable.fields.toSocket.value.entityId),
    }))
    .filter((candidate): candidate is {
      cable: NexusEntity<'desktopAudioCable'>
      mixerChannel: NexusEntity<'mixerChannel'>
    } => candidate.mixerChannel !== undefined)
    .map(({ cable, mixerChannel }) => ({ cable, mixerChannel, fxGraph: null }))

  const fxCableAndMixers = outputCables.flatMap((inputCable) => {
    const delay = entities
      .ofTypes('stompboxDelay')
      .getEntity(inputCable.fields.toSocket.value.entityId)
    const delayCable = delay
      ? cables.find((candidate) =>
        candidate.fields.fromSocket.value.equals(delay.fields.audioOutput.location))
      : undefined
    const reverb = delayCable
      ? entities.ofTypes('stompboxReverb').getEntity(delayCable.fields.toSocket.value.entityId)
      : undefined
    const reverbCable = reverb
      ? cables.find((candidate) =>
        candidate.fields.fromSocket.value.equals(reverb.fields.audioOutput.location))
      : undefined
    const distortion = reverbCable
      ? entities.ofTypes('stompboxTube').getEntity(reverbCable.fields.toSocket.value.entityId)
      : undefined
    const distortionCable = distortion
      ? cables.find((candidate) =>
        candidate.fields.fromSocket.value.equals(distortion.fields.audioOutput.location))
      : undefined
    const flanger = distortionCable
      ? entities.ofTypes('stompboxFlanger').getEntity(distortionCable.fields.toSocket.value.entityId)
        ?? entities.ofTypes('stompboxChorus').getEntity(distortionCable.fields.toSocket.value.entityId)
      : undefined
    const outputCable = flanger
      ? cables.find((candidate) =>
        candidate.fields.fromSocket.value.equals(flanger.fields.audioOutput.location))
      : undefined
    const mixerChannel = outputCable
      ? entities.ofTypes('mixerChannel').getEntity(outputCable.fields.toSocket.value.entityId)
      : undefined
    if (
      !delay
      || !delayCable
      || !reverb
      || !reverbCable
      || !distortion
      || !distortionCable
      || !flanger
      || !outputCable
      || !mixerChannel
    ) return []
    return [{
      cable: outputCable,
      mixerChannel,
      fxGraph: {
        delay,
        reverb,
        distortion,
        flanger,
        cables: [inputCable, delayCable, reverbCable, distortionCable, outputCable],
      } satisfies DeckFxGraph,
    }]
  })
  const cableAndMixers = [...directCableAndMixers, ...fxCableAndMixers]

  return entities
    .ofTypes('audioTrack')
    .get()
    .filter((candidate) => candidate.fields.player.value.entityId === audioDevice.id)
    .flatMap((track) => cableAndMixers.map(({ cable, mixerChannel, fxGraph }) => ({
      track,
      audioDevice,
      mixerChannel,
      cable,
      fxGraph,
      displayName: audioDevice.fields.displayName.value,
    })))
}

function createDeckFxDevices(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
  audioDevice: NexusEntity<'audioDevice'>,
  mixerChannel: NexusEntity<'mixerChannel'>,
): { cable: NexusEntity<'desktopAudioCable'>; fxGraph: DeckFxGraph } {
  const displayName = DECK_PROJECT_NAMES[deckIndex]
  const delay = t.create('stompboxDelay', {
    displayName: `${displayName} FX · DELAY`,
    mix: 0,
    isActive: false,
  })
  const reverb = t.create('stompboxReverb', {
    displayName: `${displayName} FX · REVERB`,
    mix: 0,
    isActive: false,
  })
  const distortion = t.create('stompboxTube', {
    displayName: `${displayName} FX · DISTORTION`,
    drive: 0.1,
    isActive: false,
  })
  const flanger = t.create('stompboxFlanger', {
    displayName: `${displayName} FX · FLANGER`,
    delayTimeMs: 3,
    feedbackFactor: 0,
    lfoFrequencyHz: 0.04,
    lfoModulationDepth: 0,
    isActive: false,
  })
  const inputCable = t.create('desktopAudioCable', {
    fromSocket: audioDevice.fields.audioOutput.location,
    toSocket: delay.fields.audioInput.location,
  })
  const delayCable = t.create('desktopAudioCable', {
    fromSocket: delay.fields.audioOutput.location,
    toSocket: reverb.fields.audioInput.location,
  })
  const reverbCable = t.create('desktopAudioCable', {
    fromSocket: reverb.fields.audioOutput.location,
    toSocket: distortion.fields.audioInput.location,
  })
  const distortionCable = t.create('desktopAudioCable', {
    fromSocket: distortion.fields.audioOutput.location,
    toSocket: flanger.fields.audioInput.location,
  })
  const outputCable = t.create('desktopAudioCable', {
    fromSocket: flanger.fields.audioOutput.location,
    toSocket: mixerChannel.fields.audioInput.location,
  })

  return {
    cable: outputCable,
    fxGraph: {
      delay,
      reverb,
      distortion,
      flanger,
      cables: [inputCable, delayCable, reverbCable, distortionCable, outputCable],
    },
  }
}

function createDeckFxGraph(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
  routing: ResolvedDeckRoutingGraph,
): ResolvedDeckRoutingGraph {
  // Nexus validates each cable immediately, so free the single-input socket first.
  t.remove(routing.cable)
  const fxRouting = createDeckFxDevices(
    t,
    deckIndex,
    routing.audioDevice,
    routing.mixerChannel,
  )
  return { ...routing, ...fxRouting }
}

async function ensureDeckFxGraph(
  projectDocument: SyncedDocument,
  deckIndex: WaveformDeckIndex,
  expectedSession: number,
) {
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
  ) throw new Error('Connect an Audiotool project before opening FX')

  return projectDocument.modify((t) => {
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
    ) throw new Error('Project connection changed while opening FX')
    const routing = reusableDeckGraphs(t.entities, deckIndex)[0]?.routing
    if (!routing) throw new Error(`${placementDeckLabel(deckIndex)} routing is unavailable`)
    return routing.fxGraph ? routing : createDeckFxGraph(t, deckIndex, routing)
  })
}

function resolveDeckContentGraph(
  entities: EntityQuery,
  routing: ResolvedDeckRoutingGraph,
): ResolvedDeckContentGraph | null {
  const regions = entities
    .ofTypes('audioRegion')
    .get()
    .filter((candidate) => candidate.fields.track.value.entityId === routing.track.id)
  const validContent = regions.flatMap((region) => {
    const sample = entities.ofTypes('sample').getEntity(region.fields.sample.value.entityId)
    const automationCollection = entities
      .ofTypes('automationCollection')
      .getEntity(region.fields.playbackAutomationCollection.value.entityId)
    const terminalEvent = getExpectedPlaybackTerminalEvent({ entities }, region)
    return sample && automationCollection && terminalEvent
      ? [{ region, sample, automationCollection }]
      : []
  })
  const latest = selectLatestLogicalRegion(
    validContent.map(({ region }) => regionSnapshot(region)),
  )
  if (!latest) return null
  return validContent.find(({ region }) => region.id === latest.id) ?? null
}

function regionSnapshot(region: NexusEntity<'audioRegion'>): TimelineRegionSnapshot {
  return {
    id: region.id,
    sampleId: region.fields.sample.value.entityId,
    automationCollectionId: region.fields.playbackAutomationCollection.value.entityId,
    positionTicks: region.fields.region.fields.positionTicks.value,
    durationTicks: region.fields.region.fields.durationTicks.value,
    fadeInDurationTicks: region.fields.fadeInDurationTicks.value,
    fadeOutDurationTicks: region.fields.fadeOutDurationTicks.value,
  }
}

function reusableDeckGraphs(
  entities: EntityQuery,
  deckIndex: WaveformDeckIndex,
): ReusableDeckGraph[] {
  const candidates = entities
    .ofTypes('audioDevice')
    .get()
    .filter((audioDevice) =>
      deckIndexFromDisplayName(audioDevice.fields.displayName.value) === deckIndex)
    .flatMap((audioDevice) => resolveDeckRoutingGraphs(entities, audioDevice))
    .map((routing) => ({
      routing,
      content: resolveDeckContentGraph(entities, routing),
      trackId: routing.track.id,
      trackOrder: routing.track.fields.orderAmongTracks.value,
      deviceName: routing.audioDevice.fields.displayName.value,
      stripName: routing.mixerChannel.fields.displayParameters.fields.displayName.value,
      routingId: `${routing.audioDevice.id}\u0000${routing.mixerChannel.id}\u0000${routing.cable.id}`,
    }))
  const selected = selectCanonicalRouting(candidates, DECK_PROJECT_NAMES[deckIndex])
  return selected ? [{ routing: selected.routing, content: selected.content }] : []
}

function nextTrackOrder(entities: EntityQuery) {
  return entities
    .ofTypes('audioTrack', 'patternTrack', 'noteTrack', 'automationTrack')
    .get()
    .reduce((order, track) => Math.max(order, track.fields.orderAmongTracks.value), -1) + 1
}

function nextMixerChannelOrder(entities: EntityQuery) {
  return entities
    .ofTypes('mixerChannel', 'mixerAux', 'mixerDelayAux', 'mixerGroup', 'mixerReverbAux')
    .get()
    .reduce(
      (order, strip) =>
        Math.max(order, strip.fields.displayParameters.fields.orderAmongStrips.value),
      -1,
    ) + 1
}

function createDeckRoutingGraph(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
): ResolvedDeckRoutingGraph {
  const displayName = DECK_PROJECT_NAMES[deckIndex]
  const audioDevice = t.create('audioDevice', { displayName })
  const track = t.create('audioTrack', {
    player: audioDevice.location,
    orderAmongTracks: nextTrackOrder(t.entities),
  })
  const mixerChannel = t.create('mixerChannel', {
    displayParameters: {
      displayName,
      orderAmongStrips: nextMixerChannelOrder(t.entities),
    },
  })
  const fxRouting = createDeckFxDevices(t, deckIndex, audioDevice, mixerChannel)
  return { track, audioDevice, mixerChannel, ...fxRouting, displayName }
}

async function ensureDeckRoutingGraph(
  projectDocument: SyncedDocument,
  deckIndex: WaveformDeckIndex,
  expectedSession: number,
) {
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
  ) throw new Error('Project connection changed before deck provisioning')

  return projectDocument.modify((t) => {
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
    ) throw new Error('Project connection changed during deck provisioning')
    const reusable = reusableDeckGraphs(t.entities, deckIndex)[0]
    if (!reusable) {
      return { routing: createDeckRoutingGraph(t, deckIndex), content: null }
    }
    return reusable.routing.fxGraph
      ? reusable
      : {
        ...reusable,
        routing: createDeckFxGraph(t, deckIndex, reusable.routing),
      }
  })
}

function isDeckGraphCurrent(
  projectDocument: SyncedDocument,
  deckIndex: WaveformDeckIndex,
  graph: ReusableDeckGraph,
) {
  return reusableDeckGraphs(projectDocument.queryEntities, deckIndex).some((candidate) =>
    candidate.routing.track.id === graph.routing.track.id
    && candidate.routing.audioDevice.id === graph.routing.audioDevice.id
    && candidate.routing.mixerChannel.id === graph.routing.mixerChannel.id
    && candidate.routing.cable.id === graph.routing.cable.id
    && candidate.content?.region.id === graph.content?.region.id
    && candidate.content?.sample.id === graph.content?.sample.id
    && candidate.content?.automationCollection.id === graph.content?.automationCollection.id)
}

function hydrateRestoredProjectControls(
  deckIndex: WaveformDeckIndex,
  entities: EntityQuery,
  mixerChannel: NexusEntity<'mixerChannel'>,
) {
  const deck = decks[deckIndex]
  const automatedVolume = getOwnedDeckVolumeAutomationValue(
    entities,
    deckIndex,
    mixerChannel,
  )
  deck.volume = Math.max(
    0,
    Math.min(
      1,
      automatedVolume ?? mixerChannel.fields.faderParameters.fields.postGain.value,
    ),
  )
  deck.gainTrim = Math.max(1, Math.min(2, mixerChannel.fields.preGain.value / PROJECT_PRE_GAIN_BASE))

  const volumeSlider = el<HTMLInputElement>(`d${deckIndex + 1}-vol`)
  const gainSlider = el<HTMLInputElement>(`d${deckIndex + 1}-gain`)
  volumeSlider.value = String(deck.volume)
  gainSlider.value = String(deck.gainTrim)
  el(`d${deckIndex + 1}-vol-val`).textContent = String(Math.round(deck.volume * 100))
  el(`d${deckIndex + 1}-gain-val`).textContent = `${deck.gainTrim.toFixed(1)}x`

  const eq = mixerChannel.fields.eq.fields
  const bandValues: Record<EqBand, number> = {
    low: eq.lowShelfGainDb.value,
    mid: (eq.lowMidGainDb.value + eq.highMidGainDb.value) / 2,
    hi: eq.highShelfGainDb.value,
  }
  for (const band of ['low', 'mid', 'hi'] as const) {
    const canvas = el<HTMLCanvasElement>(`d${deckIndex + 1}-${band}`)
    const state = knobState.get(canvas)
    if (!state) continue
    state.value = Math.max(0, Math.min(1, bandValues[band] / 36 + 0.5))
    drawKnob(canvas, state.value)
    canvas.setAttribute('aria-valuenow', String(Math.round(state.value * 100)))
  }
  hydrateDeckFilterControls(deckIndex, mixerChannel)
}

async function restoreSourceDecksFromProject(
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  const client = at
  if (
    !client
    || nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
  ) return

  const projectBpm = normalizeBpm(
    projectDocument.queryEntities.ofTypes('config').get()[0]?.fields.tempoBpm.value,
  )
  if (isSupportedBpm(projectBpm)) currentProjectBpm = projectBpm

  for (const deckIndex of [0, 1] as const) {
    const selected = reusableDeckGraphs(projectDocument.queryEntities, deckIndex)[0]
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
    ) return
    if (!selected) continue
    bindDeckRoutingGraph(deckIndex, projectDocument, selected.routing, expectedSession)
    if (!selected.content) continue

    const sampleMeta = await client.samples.get(selected.content.sample).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    )
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
      || !isDeckGraphCurrent(projectDocument, deckIndex, selected)
    ) return
    if (sampleMeta instanceof Error) {
      console.warn(`[NEXUS] Deck ${deckIndex + 1} sample metadata restore:`, sampleMeta)
      continue
    }

    const deck = decks[deckIndex]
    const metadataBpm = normalizeBpm(sampleMeta.bpm)
    const fallbackName = cleanSourceDisplayName(sampleMeta.displayName, deckIndex)
    deck.fileName =
      cleanSourceDisplayName(selected.routing.displayName, deckIndex)
      || fallbackName
      || sampleMeta.displayName
    deck.sampleBpm = isSupportedBpm(metadataBpm) ? metadataBpm : null
    deck.baseBpm = deck.sampleBpm ?? (isSupportedBpm(projectBpm) ? projectBpm : null)
    deck.sampleMeta = sampleMeta
    bindDeckContentGraph(deckIndex, projectDocument, selected.content, expectedSession)
    updateSourceDeckUi(deckIndex)
    void initializeDeckCues(deckIndex, sampleMeta)
  }
}

function cleanMagicDeckDisplayName(displayName: string) {
  return displayName
    .replace(/^\s*MAGIC\s+DECK(?=$|\s|[—–-])(?:\s*[—–-]\s*)?/i, '')
    .trim()
}

function restoredMagicPrompt(graphDisplayName: string, sampleMeta: SampleMeta) {
  const description = sampleMeta.description.trim()
  if (description) return description

  const nameCandidates = [
    cleanMagicDeckDisplayName(graphDisplayName),
    cleanMagicDeckDisplayName(sampleMeta.displayName),
  ]
  return nameCandidates.find((candidate) =>
    candidate.length > 0 && !/^magic-\d+\.wav$/i.test(candidate),
  ) ?? ''
}

async function fetchMagicWaveformPeaks(sampleMeta: SampleMeta) {
  try {
    const response = await fetch(sampleMeta.getWaveformUrl({
      resolution: 1920,
      channel: 'both',
    }))
    if (!response.ok) throw new Error(`Waveform request failed (${response.status})`)
    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) throw new Error('Waveform response was not an array')
    const peaks = payload.filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    )
    if (peaks.length === 0) throw new Error('Waveform response was empty')
    return peaks
  } catch (error) {
    console.warn('[NEXUS] Magic Deck waveform restore:', error)
    return null
  }
}

async function restoreMagicDeckFromProject(
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  const client = at
  if (
    !client
    || nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
  ) return

  const selected = reusableDeckGraphs(projectDocument.queryEntities, 2)[0]
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
  ) return
  if (!selected) return
  bindDeckRoutingGraph(2, projectDocument, selected.routing, expectedSession)
  if (!selected.content) return

  const sampleMeta = await client.samples.get(selected.content.sample).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  )
  if (sampleMeta instanceof Error) {
    console.warn('[NEXUS] Magic Deck sample metadata restore:', sampleMeta)
    return
  }

  const peaks = await fetchMagicWaveformPeaks(sampleMeta)
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
    || !isDeckGraphCurrent(projectDocument, 2, selected)
  ) return

  const magicDeck = decks[2]
  const projectBpm = normalizeBpm(
    projectDocument.queryEntities.ofTypes('config').get()[0]?.fields.tempoBpm.value,
  )
  const metadataBpm = normalizeBpm(sampleMeta.bpm)
  const fallbackName = cleanMagicDeckDisplayName(sampleMeta.displayName)
  const prompt = restoredMagicPrompt(selected.routing.displayName, sampleMeta)
  magicDeck.fileName =
    cleanMagicDeckDisplayName(selected.routing.displayName)
    || fallbackName
    || sampleMeta.displayName
  if (prompt) magicPrompt.value = prompt
  magicDeck.sampleBpm = isSupportedBpm(metadataBpm) ? metadataBpm : null
  magicDeck.baseBpm = magicDeck.sampleBpm ?? (isSupportedBpm(projectBpm) ? projectBpm : null)
  magicDeck.sampleMeta = sampleMeta
  magicWaveformPeaks = peaks
  bindDeckContentGraph(2, projectDocument, selected.content, expectedSession)
  updateDeckBpmLabel(2)
  void initializeDeckCues(2, sampleMeta)
  if (peaks) {
    drawMagicPeakWaveform(peaks)
    setMagicStatus(
      'done',
      `RESTORED · ${magicDeck.fileName} · ${formatDuration(sampleMeta.durationSeconds)}`,
    )
  } else {
    drawMagicIdle(`[ RESTORED: ${magicDeck.fileName} — WAVEFORM UNAVAILABLE ]`)
    setMagicStatus('warning', `RESTORED · ${magicDeck.fileName}`)
  }
}

async function reconcileDecksFromProject(
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  for (const deckIndex of [0, 1] as const) {
    clearSourceDeckLocalMedia(deckIndex)
    clearDeckProjectEntities(decks[deckIndex])
  }
  clearMagicDeckLocalMedia()
  clearDeckProjectEntities(decks[2])

  await restoreSourceDecksFromProject(projectDocument, expectedSession)
  await restoreMagicDeckFromProject(projectDocument, expectedSession)
}

function clearDeckContentEntities(deck: DeckState) {
  deck.contentSubscriptions.forEach((subscription) => subscription.terminate())
  deck.contentSubscriptions = []
  deck.sampleBpm = null
  deck.sampleMeta = null
  deck.regionEntity = null
  deck.sampleEntity = null
  deck.automationCollectionEntity = null
  const deckIndex = decks.indexOf(deck)
  if (deckIndex >= 0) resetDeckTempoState(deckIndex as WaveformDeckIndex)
  if (deckIndex >= 0) renderDeckTransport(deckIndex as WaveformDeckIndex)
  if (deckIndex === 0 || deckIndex === 1) {
    resetManualBpmReport(deckIndex)
  }
}

function clearDeckRoutingEntities(deck: DeckState, preserveFxAssistant = false) {
  const deckIndex = decks.indexOf(deck)
  deck.routingSubscriptions.forEach((subscription) => subscription.terminate())
  deck.routingSubscriptions = []
  deck.trackEntity = null
  deck.audioDeviceEntity = null
  deck.mixerChannelEntity = null
  deck.cableEntity = null
  deck.fxGraph = null
  if (
    !preserveFxAssistant
    && deckIndex >= 0
    && activeFxDeckIndex === deckIndex
  ) closeDeckFxAssistant()
}

function clearDeckProjectEntities(deck: DeckState) {
  clearDeckContentEntities(deck)
  clearDeckRoutingEntities(deck)
}

function isSourceDeckSynchronized(deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  return deck.fileName !== null
    && deck.sampleMeta !== null
    && deck.regionEntity !== null
    && deck.trackEntity !== null
    && deck.audioDeviceEntity !== null
    && deck.mixerChannelEntity !== null
    && deck.sampleEntity !== null
    && deck.automationCollectionEntity !== null
    && deck.cableEntity !== null
}

function cleanSourceDisplayName(displayName: string, deckIndex: 0 | 1) {
  const prefix = new RegExp(`^\\s*DECK\\s+${deckIndex + 1}(?=$|\\s|[—–-])(?:\\s*[—–-]\\s*)?`, 'i')
  return displayName.replace(prefix, '').trim()
}

function formatDuration(seconds: number | null | undefined) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—'
  const roundedSeconds = Math.round(seconds)
  const minutes = Math.floor(roundedSeconds / 60)
  return `${minutes}:${String(roundedSeconds % 60).padStart(2, '0')}`
}

function emptyCuePoints(): CuePointSlots {
  return emptyCuePointSlots()
}

function cueStorageKey(audioFootprint: string) {
  return `${CUE_STORAGE_PREFIX}${audioFootprint}`
}

async function readPersistentCueRecord(audioFootprint: string) {
  const database = await openMusicLibraryDatabase()
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const request = database
        .transaction(CUE_DATABASE_STORE_NAME, 'readonly')
        .objectStore(CUE_DATABASE_STORE_NAME)
        .get(audioFootprint)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Cue record could not be read'))
    })
  } finally {
    database.close()
  }
}

async function writePersistentCueRecord(record: StoredCuePointsV2) {
  const database = await openMusicLibraryDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(CUE_DATABASE_STORE_NAME, 'readwrite')
      const request = transaction.objectStore(CUE_DATABASE_STORE_NAME).put(record)
      request.onerror = () => reject(request.error ?? new Error('Cue record could not be saved'))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Cue record could not be saved'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Cue record save was aborted'))
    })
  } finally {
    database.close()
  }
}

function readSessionCueRecord(audioFootprint: string) {
  const raw = sessionStorage.getItem(cueStorageKey(audioFootprint))
  return Promise.resolve(raw ? JSON.parse(raw) as unknown : null)
}

function writeSessionCueRecord(audioFootprint: string, record: StoredCuePointsV1) {
  sessionStorage.setItem(cueStorageKey(audioFootprint), JSON.stringify(record))
  return Promise.resolve()
}

function removeSessionCueRecord(audioFootprint: string) {
  sessionStorage.removeItem(cueStorageKey(audioFootprint))
  return Promise.resolve()
}

async function persistCuePoints(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  if (!deck.audioFootprint) return
  try {
    if (deckIndex === 2) {
      await writeSessionCueRecord(deck.audioFootprint, {
        version: 1,
        audioFootprint: deck.audioFootprint,
        points: [...deck.cuePoints] as CuePointSlots,
      })
      return
    }
    const result = await saveCuePointMetadata({
      audioFootprint: deck.audioFootprint,
      points: deck.cuePoints,
      writePersistent: writePersistentCueRecord,
      writeSession: (record) => writeSessionCueRecord(deck.audioFootprint!, record),
    })
    deck.cuePersistenceWarning = result.persistence === 'session'
    if (result.error) console.warn('[CUES] IndexedDB save; using session fallback:', result.error)
  } catch (error) {
    console.warn('[CUES] session save:', error)
    deck.cuePersistenceWarning = true
  } finally {
    renderCueControls(deckIndex)
  }
}

function fallbackAudioHash(bytes: ArrayBuffer) {
  const values = new Uint8Array(bytes)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (const value of values) {
    first = Math.imul(first ^ value, 0x01000193)
    second = Math.imul(second ^ value, 0x85ebca6b)
    second = (second << 13) | (second >>> 19)
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0')
  return `fallback-${values.byteLength.toString(16)}-${hex(first)}${hex(second)}`
}

async function hashAudioFootprint(bytes: ArrayBuffer) {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return fallbackAudioHash(bytes)
    const digest = await subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch (error) {
    console.warn('[CUES] SHA-256 unavailable, using deterministic fallback:', error)
    return fallbackAudioHash(bytes)
  }
}

async function sampleAudioFootprint(sampleMeta: SampleMeta) {
  try {
    const response = await fetch(sampleMeta.mp3Url)
    if (!response.ok) throw new Error(`Audio request failed (${response.status})`)
    const bytes = await response.arrayBuffer()
    return await hashAudioFootprint(bytes)
  } catch (audioError) {
    console.warn('[CUES] audio fingerprint:', audioError)
    const response = await fetch(sampleMeta.getWaveformUrl({ resolution: 3840, channel: 'both' }))
    if (!response.ok) throw new Error(`Audio footprint request failed (${response.status})`)
    const waveform = await response.text()
    const canonical = new TextEncoder().encode(
      `${sampleMeta.durationSeconds.toFixed(9)}\n${waveform}`,
    )
    return hashAudioFootprint(canonical.buffer as ArrayBuffer)
  }
}

function formsCueCutBoundary(
  left: NexusEntity<'audioRegion'>,
  right: NexusEntity<'audioRegion'>,
) {
  const leftRegion = left.fields.region.fields
  const rightRegion = right.fields.region.fields
  return leftRegion.positionTicks.value + leftRegion.durationTicks.value
      === rightRegion.positionTicks.value
    && leftRegion.collectionOffsetTicks.value + leftRegion.durationTicks.value
      === rightRegion.collectionOffsetTicks.value
    && leftRegion.loopOffsetTicks.value === rightRegion.loopOffsetTicks.value
    && leftRegion.loopDurationTicks.value === rightRegion.loopDurationTicks.value
    && leftRegion.isEnabled.value === rightRegion.isEnabled.value
    && leftRegion.colorIndex.value === rightRegion.colorIndex.value
    && leftRegion.displayName.value === rightRegion.displayName.value
    && left.fields.gain.value === right.fields.gain.value
    && left.fields.timestretchMode.value === right.fields.timestretchMode.value
    && left.fields.pitchShiftSemitones.value === right.fields.pitchShiftSemitones.value
    && left.fields.fadeOutDurationTicks.value === 0
    && right.fields.fadeInDurationTicks.value === 0
}

function contiguousAudioRegions(
  entities: EntityQuery,
  anchor: NexusEntity<'audioRegion'>,
) {
  const trackId = anchor.fields.track.value.entityId
  const sampleId = anchor.fields.sample.value.entityId
  const collectionId = anchor.fields.playbackAutomationCollection.value.entityId
  const candidates = entities
    .ofTypes('audioRegion')
    .get()
    .filter((region) =>
      region.fields.track.value.entityId === trackId
      && region.fields.sample.value.entityId === sampleId
      && region.fields.playbackAutomationCollection.value.entityId === collectionId,
    )
    .sort((a, b) =>
      a.fields.region.fields.positionTicks.value - b.fields.region.fields.positionTicks.value
      || a.id.localeCompare(b.id))
  const anchorIndex = candidates.findIndex((region) => region.id === anchor.id)
  if (anchorIndex < 0) return []

  let firstIndex = anchorIndex
  while (firstIndex > 0) {
    const previous = candidates[firstIndex - 1]
    const current = candidates[firstIndex]
    if (!formsCueCutBoundary(previous, current)) break
    firstIndex -= 1
  }
  let lastIndex = anchorIndex
  while (lastIndex < candidates.length - 1) {
    const current = candidates[lastIndex]
    const next = candidates[lastIndex + 1]
    if (!formsCueCutBoundary(current, next)) break
    lastIndex += 1
  }
  return candidates.slice(firstIndex, lastIndex + 1)
}

function resizeContiguousAudioRegions(
  t: SafeTransactionBuilder,
  regions: NexusEntity<'audioRegion'>[],
  previousContentDurationTicks: number,
  nextContentDurationTicks: number,
  nextRegionDurationTicks = nextContentDurationTicks,
  nextFirstPositionTicks?: number,
) {
  if (
    regions.length === 0
    || previousContentDurationTicks <= 0
    || nextContentDurationTicks <= 0
    || nextRegionDurationTicks <= 0
  ) throw new Error('Cue-cut timing could not be resized')
  const firstPositionTicks = regions[0].fields.region.fields.positionTicks.value
  const resolvedFirstPositionTicks = nextFirstPositionTicks ?? firstPositionTicks
  const last = regions.at(-1)!
  const previousRegionDurationTicks =
    last.fields.region.fields.positionTicks.value
    + last.fields.region.fields.durationTicks.value
    - firstPositionTicks
  const scaleRegionTicks = (ticks: number) =>
    Math.round((ticks / previousRegionDurationTicks) * nextRegionDurationTicks)
  const firstRegionFields = regions[0].fields.region.fields
  const firstCollectionOffsetTicks = firstRegionFields.collectionOffsetTicks.value
  const firstLoopOffsetTicks = firstRegionFields.loopOffsetTicks.value

  regions.forEach((region, index) => {
    const fields = region.fields.region.fields
    const previousStartTicks = fields.positionTicks.value - firstPositionTicks
    const previousEndTicks = previousStartTicks + fields.durationTicks.value
    const nextStartTicks = scaleRegionTicks(previousStartTicks)
    const nextEndTicks = index === regions.length - 1
      ? nextRegionDurationTicks
      : scaleRegionTicks(previousEndTicks)
    if (nextEndTicks <= nextStartTicks) {
      throw new Error('Tempo change would collapse a cue-cut region')
    }
    t.update(fields.positionTicks, resolvedFirstPositionTicks + nextStartTicks)
    t.update(fields.durationTicks, nextEndTicks - nextStartTicks)
    const offsets = planResizedCueOffsets({
      firstCollectionOffsetTicks,
      firstLoopOffsetTicks,
      loopDurationTicks: fields.loopDurationTicks.value,
      previousContentDurationTicks,
      nextContentDurationTicks,
      nextStartTicks,
    })
    t.update(fields.collectionOffsetTicks, offsets.collectionOffsetTicks)
    t.update(fields.loopOffsetTicks, offsets.loopOffsetTicks)
    t.update(fields.loopDurationTicks, offsets.loopDurationTicks)
  })
}

function audioRegionChainDuration(regions: NexusEntity<'audioRegion'>[]) {
  const first = regions[0]
  const last = regions.at(-1)
  if (!first || !last) return 0
  return last.fields.region.fields.positionTicks.value
    + last.fields.region.fields.durationTicks.value
    - first.fields.region.fields.positionTicks.value
}

function updateAudioRegionChainEnabled(
  t: SafeTransactionBuilder,
  regions: NexusEntity<'audioRegion'>[],
  isEnabled: boolean,
) {
  regions.forEach((region) => {
    if (region.fields.region.fields.isEnabled.value !== isEnabled) {
      t.update(region.fields.region.fields.isEnabled, isEnabled)
    }
  })
}

function updateDeckRegionChainTiming(
  t: SafeTransactionBuilder,
  anchor: NexusEntity<'audioRegion'>,
  nextPositionTicks: number,
  nextDurationTicks: number,
) {
  const regions = contiguousAudioRegions(t.entities, anchor)
  if (regions.length <= 1) {
    t.update(anchor.fields.region.fields.positionTicks, nextPositionTicks)
    t.update(anchor.fields.region.fields.durationTicks, nextDurationTicks)
    return regions.length === 1 ? regions : [anchor]
  }
  const terminalEvent = getExpectedPlaybackTerminalEvent(t, anchor)
  const contentDurationTicks = terminalEvent?.fields.positionTicks.value
    ?? anchor.fields.region.fields.loopDurationTicks.value
  resizeContiguousAudioRegions(
    t,
    regions,
    contentDurationTicks,
    contentDurationTicks,
    nextDurationTicks,
    nextPositionTicks,
  )
  return regions
}

function collapseLegacyCueChain(
  t: SafeTransactionBuilder,
  anchor: NexusEntity<'audioRegion'>,
) {
  const regions = contiguousAudioRegions(t.entities, anchor)
  if (regions.length <= 1) return regions[0] ?? anchor
  const plan = planLegacyCueChainCollapse(regions.map((region) => ({
    id: region.id,
    positionTicks: region.fields.region.fields.positionTicks.value,
    durationTicks: region.fields.region.fields.durationTicks.value,
  })))
  const keep = regions.find((region) => region.id === plan.keepId)
  const last = regions.at(-1)
  if (!keep || !last) throw new Error('Legacy cue chain changed before collapse')
  t.update(keep.fields.region.fields.durationTicks, plan.durationTicks)
  t.update(keep.fields.fadeOutDurationTicks, last.fields.fadeOutDurationTicks.value)
  t.update(keep.fields.fadeOutSlope, last.fields.fadeOutSlope.value)
  plan.removeIds.forEach((regionId) => {
    const redundant = regions.find((region) => region.id === regionId)
    if (redundant) t.remove(redundant)
  })
  return keep
}

function applySourceDeckLaunchPlan(
  t: SafeTransactionBuilder,
  region: NexusEntity<'audioRegion'>,
  plan: ReturnType<typeof planRegionLaunch>,
  fullDurationTicks: number,
) {
  const scheduledRegion = collapseLegacyCueChain(t, region)
  const fields = scheduledRegion.fields.region.fields
  t.update(fields.positionTicks, plan.positionTicks)
  t.update(fields.collectionOffsetTicks, plan.cueOffsetTicks)
  t.update(fields.durationTicks, plan.durationTicks)
  t.update(fields.loopDurationTicks, fullDurationTicks)
  if (!fields.isEnabled.value) t.update(fields.isEnabled, true)
  if (scheduledRegion.fields.fadeInDurationTicks.value > plan.durationTicks) {
    t.update(scheduledRegion.fields.fadeInDurationTicks, plan.durationTicks)
  }
  const maximumFadeOutTicks = Math.max(
    0,
    plan.durationTicks - Math.min(scheduledRegion.fields.fadeInDurationTicks.value, plan.durationTicks),
  )
  if (scheduledRegion.fields.fadeOutDurationTicks.value > maximumFadeOutTicks) {
    t.update(scheduledRegion.fields.fadeOutDurationTicks, maximumFadeOutTicks)
  }
  return scheduledRegion
}

function deckCueRegions(entities: EntityQuery, deckIndex: WaveformDeckIndex) {
  const regionId = decks[deckIndex].regionEntity?.id
  if (!regionId) return []
  const anchor = entities.ofTypes('audioRegion').getEntity(regionId)
  return anchor ? contiguousAudioRegions(entities, anchor) : []
}

function sourceDeckInstances(
  entities: EntityQuery,
  deckIndex: 0 | 1,
  anchorOverride?: NexusEntity<'audioRegion'>,
) {
  const anchor = anchorOverride
    ?? (decks[deckIndex].regionEntity
      ? entities.ofTypes('audioRegion').getEntity(decks[deckIndex].regionEntity!.id)
      : undefined)
  const trackId = anchor?.fields.track.value.entityId ?? decks[deckIndex].trackEntity?.id
  const sampleId = anchor?.fields.sample.value.entityId ?? decks[deckIndex].sampleEntity?.id
  if (!trackId || !sampleId) return []

  const visited = new Set<string>()
  return entities
    .ofTypes('audioRegion')
    .get()
    .filter((candidate) =>
      candidate.fields.track.value.entityId === trackId
      && candidate.fields.sample.value.entityId === sampleId,
    )
    .sort((left, right) =>
      left.fields.region.fields.positionTicks.value
        - right.fields.region.fields.positionTicks.value
      || left.id.localeCompare(right.id))
    .flatMap((candidate) => {
      if (visited.has(candidate.id) || !getExpectedPlaybackTerminalEvent({ entities }, candidate)) {
        return []
      }
      const chain = contiguousAudioRegions(entities, candidate)
      chain.forEach((region) => visited.add(region.id))
      return [chain[0] ?? candidate]
    })
}

function sourceDeckInstanceRegions(
  entities: EntityQuery,
  deckIndex: 0 | 1,
  anchorOverride?: NexusEntity<'audioRegion'>,
) {
  return sourceDeckInstances(entities, deckIndex, anchorOverride)
    .flatMap((instance) => contiguousAudioRegions(entities, instance))
}

function projectCuePositions(entities: EntityQuery, deckIndex: WaveformDeckIndex) {
  return cuePositionsFromSegments(deckCueRegions(entities, deckIndex).map((region) => ({
    id: region.id,
    positionTicks: region.fields.region.fields.positionTicks.value,
    durationTicks: region.fields.region.fields.durationTicks.value,
  }))).slice(0, 5)
}

function resetDeckCueState(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  deck.cueLoadId += 1
  deck.audioFootprint = null
  deck.cuePoints = emptyCuePoints()
  deck.cuePosition = 0
  deck.cueLoading = false
  deck.scheduledCuePosition = 0
  deck.cuePersistenceWarning = false
  renderCueControls(deckIndex)
}

function resetDeckCuePosition(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  deck.cuePosition = 0
  renderCueControls(deckIndex)
}

function formatCueTime(deckIndex: WaveformDeckIndex, position: number) {
  const durationSeconds = decks[deckIndex].sampleMeta?.durationSeconds
  if (!durationSeconds || !Number.isFinite(durationSeconds)) return '—'
  return formatDuration(Math.min(durationSeconds, Math.max(0, position * durationSeconds)))
}

function getCueElements(deckIndex: WaveformDeckIndex) {
  const prefix = `d${deckIndex + 1}-cue`
  return {
    module: el<HTMLDivElement>(`${prefix}-module`),
    slider: el<HTMLInputElement>(`${prefix}-position`),
    position: el<HTMLOutputElement>(`${prefix}-position-value`),
    status: el<HTMLSpanElement>(`${prefix}-status`),
    pads: Array.from({ length: 5 }, (_, slot) => ({
      trigger: el<HTMLButtonElement>(`${prefix}-${slot + 1}`),
      clear: el<HTMLButtonElement>(`${prefix}-${slot + 1}-clear`),
    })),
  }
}

function isCueDeckLoaded(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  return deck.sampleMeta !== null && deck.regionEntity !== null
}

function renderCueControls(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const controls = getCueElements(deckIndex)
  const loaded = isCueDeckLoaded(deckIndex)
  const operationPending = deckOperationStates[deckIndex].pendingCount > 0
    || deck.tempoUpdatePending
  const ready = projectConnected
    && loaded
    && deck.audioFootprint !== null
    && !deck.cueLoading
    && !operationPending
  const fullDurationTicks = deckIndex < 2
    ? getSynchronizedDeckFullDurationTicks(deckIndex)
    : null
  controls.module.classList.toggle('is-disabled', !loaded)
  controls.slider.disabled = !ready
  if (deckIndex < 2 && fullDurationTicks !== null) {
    const maximumBar = Math.floor((fullDurationTicks - 1) / Ticks.Bars(1)) + 1
    controls.slider.min = '1'
    controls.slider.max = String(maximumBar)
    controls.slider.step = '1'
    controls.slider.value = String(cueBarForPosition(
      deck.cuePosition,
      Ticks.Bars(1),
      fullDurationTicks,
    ))
    controls.position.value = `B${controls.slider.value} · ${formatCueTime(deckIndex, deck.cuePosition)}`
  } else {
    controls.slider.min = '0'
    controls.slider.max = '999'
    controls.slider.step = '1'
    controls.slider.value = String(Math.round(deck.cuePosition * 1000))
    controls.position.value = formatCueTime(deckIndex, deck.cuePosition)
  }
  controls.status.textContent = deckOperationStates[deckIndex].activeKind === 'cue-scheduling'
    ? 'SCHEDULING SAVED CUE…'
    : deck.cueLoading
      ? deckIndex < 2 ? 'LOADING CUE METADATA…' : 'SYNCING PROJECT CUTS…'
      : ready
        ? deckIndex < 2
          ? deck.cuePersistenceWarning
            ? 'CUES ARE SESSION-ONLY · INDEXEDDB PERSISTENCE UNAVAILABLE'
            : 'CHOOSE A SOURCE BAR · SET A PAD OR SELECT A SAVED CUE TO SCHEDULE IT'
          : 'SET EMPTY PAD TO CUT THE AUDIOTOOL REGION · × JOINS THE CUT'
        : loaded
          ? 'CUES UNAVAILABLE'
          : 'LOAD A TRACK TO ADD CUES'
  controls.pads.forEach(({ trigger, clear }, slot) => {
    const point = deck.cuePoints[slot]
    trigger.disabled = !ready
    trigger.classList.toggle('is-set', point !== null)
    const scheduled = deckIndex < 2
      && point !== null
      && Math.abs(point - deck.scheduledCuePosition) < 0.000_5
    trigger.classList.toggle('is-scheduled', scheduled)
    trigger.textContent = point === null
      ? `CUE ${slot + 1}\nSET`
      : `CUE ${slot + 1}\n${formatCueTime(deckIndex, point)}`
    trigger.setAttribute(
      'aria-label',
      point === null
        ? deckIndex < 2
          ? `Save cue ${slot + 1} at source track bar ${controls.slider.value}`
          : `Create Audiotool cut ${slot + 1} at ${formatCueTime(deckIndex, deck.cuePosition)}`
        : deckIndex < 2
          ? `Schedule cue ${slot + 1} from source track bar ${fullDurationTicks === null ? '—' : cueBarForPosition(point, Ticks.Bars(1), fullDurationTicks)}`
          : `Select Audiotool cut ${slot + 1} at ${formatCueTime(deckIndex, point)}`,
    )
    clear.disabled = !ready || point === null
    clear.classList.toggle('is-hidden', point === null)
  })
}

async function initializeDeckCues(
  deckIndex: WaveformDeckIndex,
  sampleMeta: SampleMeta,
) {
  const deck = decks[deckIndex]
  const loadId = ++deck.cueLoadId
  deck.audioFootprint = null
  deck.cuePoints = emptyCuePoints()
  deck.cuePosition = 0
  deck.cueLoading = true
  deck.cuePersistenceWarning = false
  renderCueControls(deckIndex)
  try {
    const audioFootprint = await sampleAudioFootprint(sampleMeta)
    if (loadId !== deck.cueLoadId || deck.sampleMeta !== sampleMeta) return
    deck.audioFootprint = audioFootprint
    const authoritativePoints = nexus
      ? projectCuePositions(nexus.queryEntities, deckIndex)
      : []
    const result = deckIndex < 2
      ? await loadCuePointMetadata({
          audioFootprint,
          authoritativePoints,
          readPersistent: () => readPersistentCueRecord(audioFootprint),
          readSession: () => readSessionCueRecord(audioFootprint),
          writePersistent: writePersistentCueRecord,
          writeSession: (record) => writeSessionCueRecord(audioFootprint, record),
          removeSession: () => removeSessionCueRecord(audioFootprint),
        })
      : {
          points: reconcileLegacyCuePoints(
            parseCueRecordV1(await readSessionCueRecord(audioFootprint), audioFootprint)
              ?? emptyCuePoints(),
            authoritativePoints,
          ),
          persistence: 'session' as const,
          migrated: false,
        }
    if (loadId !== deck.cueLoadId || deck.sampleMeta !== sampleMeta) return
    deck.cuePoints = result.points
    deck.cuePersistenceWarning = deckIndex < 2 && result.persistence === 'session'
    if ('error' in result && result.error) {
      console.warn('[CUES] IndexedDB unavailable; using session fallback:', result.error)
    }
    if (deckIndex === 2) await persistCuePoints(deckIndex)
  } catch (error) {
    if (loadId !== deck.cueLoadId) return
    console.warn(`[CUES] ${placementDeckLabel(deckIndex)} initialization:`, error)
  } finally {
    if (loadId === deck.cueLoadId) {
      deck.cueLoading = false
      renderCueControls(deckIndex)
    }
  }
}

async function createProjectCueCut(deckIndex: WaveformDeckIndex, slot: number) {
  const deck = decks[deckIndex]
  if (deckIndex < 2) {
    const fullDurationTicks = getSynchronizedDeckFullDurationTicks(deckIndex)
    if (fullDurationTicks === null) throw new Error('The synchronized track duration is unavailable')
    const position = cuePositionForBar(
      cueBarForPosition(deck.cuePosition, Ticks.Bars(1), fullDurationTicks),
      Ticks.Bars(1),
      fullDurationTicks,
    )
    deck.cuePoints[slot] = position
    deck.cuePosition = position
    renderCueControls(deckIndex)
    await persistCuePoints(deckIndex)
    setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE ${slot + 1} SAVED AT SOURCE TRACK BAR ${cueBarForPosition(position, Ticks.Bars(1), fullDurationTicks)} · SELECT IT AGAIN TO SCHEDULE`)
    return
  }
  const projectDocument = nexus
  const expectedSession = tempoSessionId
  const regionId = deck.regionEntity?.id
  if (!projectDocument || !projectConnected || !regionId) {
    throw new Error('The synchronized Audiotool region is required')
  }
  const operationId = ++deck.cueLoadId
  const requestedPosition = deck.cuePosition
  deck.cueLoading = true
  renderCueControls(deckIndex)
  try {
    const result = await serializeSourceTiming(() => projectDocument.modify((t) => {
      if (
        nexus !== projectDocument
        || !projectConnected
        || expectedSession !== tempoSessionId
        || deck.regionEntity?.id !== regionId
        || deck.cueLoadId !== operationId
      ) throw new Error('Project connection changed before the cue cut')
      const regions = deckCueRegions(t.entities, deckIndex)
      if (regions.length === 0) throw new Error('The Audiotool region is no longer available')
      const firstPositionTicks = regions[0].fields.region.fields.positionTicks.value
      const last = regions.at(-1)!
      const endPositionTicks =
        last.fields.region.fields.positionTicks.value
        + last.fields.region.fields.durationTicks.value
      const fullDurationTicks = endPositionTicks - firstPositionTicks
      const cutTicks = firstPositionTicks + Math.round(requestedPosition * fullDurationTicks)
      if (cutTicks <= firstPositionTicks || cutTicks >= endPositionTicks) {
        throw new Error('Move the cue away from the start or end of the region')
      }
      const existingCut = regions.find((region) =>
        region.fields.region.fields.positionTicks.value === cutTicks)
      if (existingCut) {
        throw new Error('There is already an Audiotool cut at this position')
      }
      const containingRegion = regions.find((region) => {
        const positionTicks = region.fields.region.fields.positionTicks.value
        return cutTicks > positionTicks
          && cutTicks < positionTicks + region.fields.region.fields.durationTicks.value
      })
      if (!containingRegion) throw new Error('Move the cue away from a region edge')
      const regionFields = containingRegion.fields.region.fields
      const split = planAudioRegionSplit({
        positionTicks: regionFields.positionTicks.value,
        durationTicks: regionFields.durationTicks.value,
        collectionOffsetTicks: regionFields.collectionOffsetTicks.value,
        loopOffsetTicks: regionFields.loopOffsetTicks.value,
        loopDurationTicks: regionFields.loopDurationTicks.value,
      }, cutTicks)
      const originalFadeOutTicks = containingRegion.fields.fadeOutDurationTicks.value
      const leftFadeInTicks = Math.min(
        containingRegion.fields.fadeInDurationTicks.value,
        split.leftDurationTicks,
      )
      const rightFadeOutTicks = Math.min(
        originalFadeOutTicks,
        split.right.durationTicks,
      )
      t.update(containingRegion.fields.fadeInDurationTicks, leftFadeInTicks)
      t.update(containingRegion.fields.fadeOutDurationTicks, 0)
      t.update(regionFields.durationTicks, split.leftDurationTicks)
      t.create('audioRegion', buildIndependentAudioRegionCopy({
        region: {
          positionTicks: regionFields.positionTicks.value,
          durationTicks: regionFields.durationTicks.value,
          collectionOffsetTicks: regionFields.collectionOffsetTicks.value,
          loopOffsetTicks: regionFields.loopOffsetTicks.value,
          loopDurationTicks: regionFields.loopDurationTicks.value,
          isEnabled: regionFields.isEnabled.value,
          colorIndex: regionFields.colorIndex.value,
          displayName: regionFields.displayName.value,
        },
        track: containingRegion.fields.track.value,
        playbackAutomationCollection:
          containingRegion.fields.playbackAutomationCollection.value,
        sample: containingRegion.fields.sample.value,
        gain: containingRegion.fields.gain.value,
        fadeInDurationTicks: containingRegion.fields.fadeInDurationTicks.value,
        fadeInSlope: containingRegion.fields.fadeInSlope.value,
        fadeOutDurationTicks: originalFadeOutTicks,
        fadeOutSlope: containingRegion.fields.fadeOutSlope.value,
        timestretchMode: containingRegion.fields.timestretchMode.value,
        pitchShiftSemitones: containingRegion.fields.pitchShiftSemitones.value,
      }, {
        region: split.right,
        fadeInDurationTicks: 0,
        fadeOutDurationTicks: rightFadeOutTicks,
      }))
      return { cuePosition: (cutTicks - firstPositionTicks) / fullDurationTicks }
    }))
    if (
      nexus !== projectDocument
      || expectedSession !== tempoSessionId
      || deck.regionEntity?.id !== regionId
      || deck.cueLoadId !== operationId
    ) return
    deck.cuePoints[slot] = result.cuePosition
    deck.cuePosition = result.cuePosition
    void persistCuePoints(deckIndex)
    setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE ${slot + 1} CUT IN AUDIOTOOL AT ${formatCueTime(deckIndex, result.cuePosition)}`)
  } finally {
    if (deck.cueLoadId === operationId) {
      deck.cueLoading = false
      renderCueControls(deckIndex)
    }
  }
}

async function removeProjectCueCut(deckIndex: WaveformDeckIndex, slot: number) {
  const deck = decks[deckIndex]
  if (deckIndex < 2) {
    if (deck.cuePoints[slot] === null) return
    deck.cuePoints[slot] = null
    renderCueControls(deckIndex)
    await persistCuePoints(deckIndex)
    setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE ${slot + 1} METADATA CLEARED · SCHEDULED AUDIO UNCHANGED`)
    return
  }
  const projectDocument = nexus
  const expectedSession = tempoSessionId
  const regionId = deck.regionEntity?.id
  const cuePosition = deck.cuePoints[slot]
  if (!projectDocument || !projectConnected || !regionId || cuePosition === null) {
    throw new Error('The synchronized Audiotool cut is no longer available')
  }
  const operationId = ++deck.cueLoadId
  deck.cueLoading = true
  renderCueControls(deckIndex)
  try {
    const authoritativePoints = await serializeSourceTiming(() => projectDocument.modify((t) => {
      if (
        nexus !== projectDocument
        || !projectConnected
        || expectedSession !== tempoSessionId
        || deck.regionEntity?.id !== regionId
        || deck.cueLoadId !== operationId
      ) throw new Error('Project connection changed before joining the cue cut')
      const regions = deckCueRegions(t.entities, deckIndex)
      const firstPositionTicks = regions[0]?.fields.region.fields.positionTicks.value
      const last = regions.at(-1)
      if (firstPositionTicks === undefined || !last) {
        throw new Error('The Audiotool regions are no longer available')
      }
      const endPositionTicks =
        last.fields.region.fields.positionTicks.value
        + last.fields.region.fields.durationTicks.value
      const fullDurationTicks = endPositionTicks - firstPositionTicks
      const closestCut = regions
        .slice(1)
        .map((region, index) => ({
          difference: Math.abs(
            (region.fields.region.fields.positionTicks.value - firstPositionTicks)
              / fullDurationTicks
              - cuePosition,
          ),
          rightIndex: index + 1,
        }))
        .sort((a, b) => a.difference - b.difference)[0]
      const rightIndex = closestCut && closestCut.difference < 0.000_5
        ? closestCut.rightIndex
        : -1
      if (rightIndex <= 0) throw new Error('The Audiotool cut was changed or removed')
      const left = regions[rightIndex - 1]
      const right = regions[rightIndex]
      const mergedDurationTicks =
        left.fields.region.fields.durationTicks.value
        + right.fields.region.fields.durationTicks.value
      t.update(
        left.fields.region.fields.durationTicks,
        mergedDurationTicks,
      )
      t.update(left.fields.fadeOutDurationTicks, right.fields.fadeOutDurationTicks.value)
      t.remove(right)
      const remaining = regions.filter((region) => region.id !== right.id)
      return cuePositionsFromSegments(remaining.map((region) => ({
        id: region.id,
        positionTicks: region.fields.region.fields.positionTicks.value,
        durationTicks: region.id === left.id
          ? mergedDurationTicks
          : region.fields.region.fields.durationTicks.value,
      }))).slice(0, 5)
    }))
    if (
      nexus !== projectDocument
      || expectedSession !== tempoSessionId
      || deck.regionEntity?.id !== regionId
      || deck.cueLoadId !== operationId
    ) return
    deck.cuePoints[slot] = null
    deck.cuePoints = reconcileLegacyCuePoints(deck.cuePoints, authoritativePoints)
    void persistCuePoints(deckIndex)
    setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE ${slot + 1} CUT JOINED IN AUDIOTOOL`)
  } finally {
    if (deck.cueLoadId === operationId) {
      deck.cueLoading = false
      renderCueControls(deckIndex)
    }
  }
}

async function mutateSourceCueSchedule(
  deckIndex: 0 | 1,
  slot: number,
  expectedSession: number,
) {
  const projectDocument = nexus
  const deck = decks[deckIndex]
  const regionId = deck.regionEntity?.id
  const cuePosition = deck.cuePoints[slot]
  const fullDurationTicks = getSynchronizedDeckFullDurationTicks(deckIndex)
  if (!projectDocument || !projectConnected || !regionId || cuePosition === null) {
    throw new Error('The synchronized deck cue is no longer available')
  }
  if (fullDurationTicks === null) {
    throw new Error('The synchronized track duration is unavailable')
  }

  const targetBar = await showBarAssistant(deckIndex, 'cue-launch', {
    cueNumber: slot + 1,
    cuePosition,
    cueSourceBar: cueBarForPosition(cuePosition, Ticks.Bars(1), fullDurationTicks),
  })
  if (targetBar === null) {
    setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE ${slot + 1} SCHEDULING CANCELLED · PROJECT TIMELINE UNCHANGED`)
    return false
  }
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
    || deck.regionEntity?.id !== regionId
    || deck.cuePoints[slot] !== cuePosition
  ) {
    throw new Error('Project or cue state changed during cue scheduling')
  }
  const targetTicks = barToPositionTicks(targetBar, Ticks.Bars(1))

  const takeoverGuardedIds: string[] = []
  try {
    const duplicate = await serializeSourceTiming(() => projectDocument.modify((t) => {
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
      || deck.regionEntity?.id !== regionId
      || deck.cuePoints[slot] !== cuePosition
    ) throw new Error('Project or cue state changed before cue scheduling')
    const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
    if (!region) throw new Error('The synchronized deck region is no longer available')
    const sample = t.entities.ofTypes('sample').getEntity(region.fields.sample.value.entityId)
    if (!sample) throw new Error('The synchronized deck sample is no longer available')
    const currentFullDurationTicks = getDeckFullDurationTicks(t, deckIndex, region)
    const automationCollection = t.create('automationCollection', {})
    t.create('automationEvent', {
      collection: automationCollection.location,
      positionTicks: 0,
      value: 0,
      interpolation: 2,
    })
    const plan = planCueRegionDuplicate({
      source: {
        region: {
          positionTicks: region.fields.region.fields.positionTicks.value,
          durationTicks: region.fields.region.fields.durationTicks.value,
          collectionOffsetTicks: region.fields.region.fields.collectionOffsetTicks.value,
          loopOffsetTicks: region.fields.region.fields.loopOffsetTicks.value,
          loopDurationTicks: region.fields.region.fields.loopDurationTicks.value,
          isEnabled: region.fields.region.fields.isEnabled.value,
          colorIndex: region.fields.region.fields.colorIndex.value,
          displayName: region.fields.region.fields.displayName.value,
        },
        track: region.fields.track.value,
        playbackAutomationCollection: region.fields.playbackAutomationCollection.value,
        sample: region.fields.sample.value,
        gain: region.fields.gain.value,
        fadeInDurationTicks: region.fields.fadeInDurationTicks.value,
        fadeInSlope: region.fields.fadeInSlope.value,
        fadeOutDurationTicks: region.fields.fadeOutDurationTicks.value,
        fadeOutSlope: region.fields.fadeOutSlope.value,
        timestretchMode: region.fields.timestretchMode.value,
        pitchShiftSemitones: region.fields.pitchShiftSemitones.value,
      },
      playbackAutomationCollection: automationCollection.location,
      targetPositionTicks: targetTicks,
      fullDurationTicks: currentFullDurationTicks,
      cuePosition,
    })
    const trackId = region.fields.track.value.entityId
    const destinationRegions = t.entities
      .ofTypes('audioRegion')
      .get()
      .filter((candidate) => candidate.fields.track.value.entityId === trackId)
    const takeover = planNonOverlappingCueTakeover(
      destinationRegions.map(regionSnapshot),
      plan.region.region.positionTicks,
      plan.region.region.durationTicks,
    )
    takeover.truncate.forEach((truncation) => {
      const existing = t.entities.ofTypes('audioRegion').getEntity(truncation.id)
      if (!existing || existing.fields.track.value.entityId !== trackId) {
        throw new Error('Deck content changed during cue takeover planning')
      }
      t.update(existing.fields.region.fields.durationTicks, truncation.durationTicks)
      if (existing.fields.fadeInDurationTicks.value !== truncation.fadeInDurationTicks) {
        t.update(existing.fields.fadeInDurationTicks, truncation.fadeInDurationTicks)
      }
      if (existing.fields.fadeOutDurationTicks.value !== truncation.fadeOutDurationTicks) {
        t.update(existing.fields.fadeOutDurationTicks, truncation.fadeOutDurationTicks)
      }
    })
    const removedIds = new Set(takeover.removeRegionIds)
    const removedAutomationCollectionIds = new Set<string>()
    takeover.removeRegionIds.forEach((existingRegionId) => {
      const existing = t.entities.ofTypes('audioRegion').getEntity(existingRegionId)
      if (!existing || existing.fields.track.value.entityId !== trackId) {
        throw new Error('Deck content changed during cue takeover planning')
      }
      removedAutomationCollectionIds.add(
        existing.fields.playbackAutomationCollection.value.entityId,
      )
      guardedRegionRemovalIds.add(existingRegionId)
      takeoverGuardedIds.push(existingRegionId)
      t.remove(existing)
    })
    removedAutomationCollectionIds.forEach((collectionId) => {
      const stillUsed = t.entities
        .ofTypes('audioRegion')
        .get()
        .some((candidate) =>
          !removedIds.has(candidate.id)
          && candidate.fields.playbackAutomationCollection.value.entityId === collectionId)
      const collection = stillUsed
        ? undefined
        : t.entities.ofTypes('automationCollection').getEntity(collectionId)
      if (collection) t.removeWithDependencies(collection)
    })
    t.create('automationEvent', {
      collection: automationCollection.location,
      positionTicks: plan.automationTerminalTicks,
      value: 1,
    })
    const duplicateRegion = t.create('audioRegion', plan.region)
    return { region: duplicateRegion, sample, automationCollection }
    }))
    if (
      nexus !== projectDocument
      || expectedSession !== tempoSessionId
      || (deck.regionEntity?.id !== regionId
        && !takeoverGuardedIds.includes(regionId))
    ) throw new Error('Project connection changed after cue scheduling')
    bindDeckContentGraph(deckIndex, projectDocument, {
      region: duplicate.region,
      sample: duplicate.sample,
      automationCollection: duplicate.automationCollection,
    }, expectedSession)
    deck.scheduledCuePosition = cuePosition
    deck.cuePosition = cuePosition
    renderCueControls(deckIndex)
    return true
  } finally {
    takeoverGuardedIds.forEach((guardedId) => guardedRegionRemovalIds.delete(guardedId))
  }
}

function setupCueControls(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const controls = getCueElements(deckIndex)
  controls.slider.addEventListener('input', () => {
    if (deckIndex < 2) {
      const fullDurationTicks = getSynchronizedDeckFullDurationTicks(deckIndex)
      if (fullDurationTicks === null) return
      deck.cuePosition = cuePositionForBar(
        Number(controls.slider.value),
        Ticks.Bars(1),
        fullDurationTicks,
      )
    } else {
      deck.cuePosition = Number(controls.slider.value) / 1000
    }
    renderCueControls(deckIndex)
  })
  controls.pads.forEach(({ trigger, clear }, slot) => {
    trigger.addEventListener('click', () => {
      const point = deck.cuePoints[slot]
      if (point === null) {
        void createProjectCueCut(deckIndex, slot).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const action = deckIndex < 2 ? 'CUE SAVE' : 'CUE CUT'
          setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: ${action} FAILED — ${message}`)
        })
        return
      }
      deck.cuePosition = point
      renderCueControls(deckIndex)
      if (deckIndex < 2) {
        const sourceDeckIndex = deckIndex as 0 | 1
        queueDeckTransportOperation(
          sourceDeckIndex,
          'cue-scheduling',
          (expectedSession) => mutateSourceCueSchedule(sourceDeckIndex, slot, expectedSession),
        )
      } else {
        setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE ${slot + 1} SELECTED — PLAYBACK REMAINS IN AUDIOTOOL`)
      }
    })
    clear.addEventListener('click', () => {
      void removeProjectCueCut(deckIndex, slot).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: CUE JOIN FAILED — ${message}`)
      })
    })
  })
  renderCueControls(deckIndex)
}

function updateSourceDeckUi(deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  const operation = deckOperationStates[deckIndex]
  const loaded = isSourceDeckSynchronized(deckIndex)
  const pending = operation.pendingCount > 0 || decks[deckIndex].tempoUpdatePending
  const zone = el<HTMLDivElement>(`drop-${deckIndex + 1}`)
  const filename = el<HTMLDivElement>(`drop${deckIndex + 1}-filename`)
  const metadataBpm = el<HTMLElement>(`drop${deckIndex + 1}-bpm`)
  const metadataDuration = el<HTMLElement>(`drop${deckIndex + 1}-duration`)
  const unload = el<HTMLButtonElement>(`deck${deckIndex + 1}-unload`)
  const uploadIndicator = el<HTMLDivElement>(`deck${deckIndex + 1}-upload-indicator`)

  zone.classList.toggle('loaded', loaded)
  zone.classList.toggle('pending', pending)
  zone.setAttribute('aria-busy', String(pending))
  el(`deck-${deckIndex + 1}`).setAttribute('aria-busy', String(operation.uploading))
  uploadIndicator.hidden = !operation.uploading
  filename.textContent = loaded ? deck.fileName ?? '' : ''
  const bpm = loaded ? normalizeBpm(deck.sampleBpm ?? deck.baseBpm) : null
  metadataBpm.textContent = bpm === null ? '—' : String(bpm)
  metadataDuration.textContent = loaded ? formatDuration(deck.sampleMeta?.durationSeconds) : '—'
  unload.classList.toggle('is-hidden', !loaded)
  unload.disabled = pending || !projectConnected || activeFxDeckIndex === deckIndex
  renderTempoControls(deckIndex)
  renderDeckTransport(deckIndex)
  renderCueControls(deckIndex)
  updateManualBpmReportUi(deckIndex)
  if (activeLibraryDeckIndex === deckIndex) renderDeckLibraryView(deckIndex)
  renderDeckLibraryAvailability()
}

function clearSourceDeckLocalMedia(deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  resetDeckCueState(deckIndex)
  deck.audioBuffer = null
  deck.fileName = null
  deck.baseBpm = null
  deck.playbackRate = 1
}

function clearMagicDeckLocalMedia() {
  const magicDeck = decks[2]
  resetDeckCueState(2)
  magicDeck.audioBuffer = null
  magicDeck.fileName = null
  magicDeck.baseBpm = null
  magicDeck.sampleBpm = null
  magicDeck.sampleMeta = null
  magicDeck.playbackRate = 1
  magicWaveformPeaks = null
  renderTempoControls(2)
  renderDeckTransport(2)
  drawMagicIdle()
}

function normalizeBpm(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : null
}

function isSupportedBpm(value: number | null | undefined): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_SUPPORTED_BPM
    && value <= MAX_SUPPORTED_BPM
}

function getManualBpmReportElements(deckIndex: 0 | 1) {
  const prefix = `deck${deckIndex + 1}-bpm-report`
  return {
    trigger: el<HTMLButtonElement>(`${prefix}-trigger`),
    form: el<HTMLDivElement>(`${prefix}-form`),
    input: el<HTMLInputElement>(`${prefix}-input`),
    apply: el<HTMLButtonElement>(`${prefix}-apply`),
    cancel: el<HTMLButtonElement>(`${prefix}-cancel`),
    error: el<HTMLDivElement>(`${prefix}-error`),
  }
}

function canReportManualBpm(deckIndex: 0 | 1) {
  return projectConnected
    && nexus !== null
    && isSourceDeckSynchronized(deckIndex)
}

function updateManualBpmReportUi(deckIndex: 0 | 1) {
  const state = manualBpmReportStates[deckIndex]
  const controls = getManualBpmReportElements(deckIndex)
  const available = canReportManualBpm(deckIndex)
  controls.trigger.classList.toggle('is-hidden', !available || state.editing)
  controls.form.classList.toggle('is-hidden', !available || !state.editing)
  controls.trigger.disabled = state.pending
    || activeFxDeckIndex === deckIndex
    || activeLibraryDeckIndex === deckIndex
  controls.input.disabled = state.pending
  controls.apply.disabled = state.pending
  controls.cancel.disabled = state.pending
  renderDeckLibraryAvailability()
}

function resetManualBpmReport(deckIndex: 0 | 1) {
  const state = manualBpmReportStates[deckIndex]
  state.requestId += 1
  state.editing = false
  state.pending = false
  const controls = getManualBpmReportElements(deckIndex)
  controls.error.textContent = ''
  updateManualBpmReportUi(deckIndex)
}

function loadedSourceDeckCount(t: SafeTransactionBuilder) {
  return decks.slice(0, 2).reduce((count, deck) => {
    if (!deck.regionEntity) return count
    const region = t.entities.ofTypes('audioRegion').getEntity(deck.regionEntity.id)
    return region ? count + 1 : count
  }, 0)
}

function getExpectedPlaybackTerminalEvent(
  t: { entities: EntityQuery },
  region: NexusEntity<'audioRegion'>,
) {
  const collectionId = region.fields.playbackAutomationCollection.value.entityId
  const collection = t.entities.ofTypes('automationCollection').getEntity(collectionId)
  if (!collection) return null
  const regionUsers = t.entities
    .ofTypes('audioRegion')
    .get()
    .filter((candidate) =>
      candidate.fields.playbackAutomationCollection.value.entityId === collectionId,
    )
  const contiguousUsers = contiguousAudioRegions(t.entities, region)
  if (
    !regionUsers.some((candidate) => candidate.id === region.id)
    || regionUsers.length !== contiguousUsers.length
    || regionUsers.some((candidate) =>
      !contiguousUsers.some((contiguous) => contiguous.id === candidate.id))
  ) return null
  const events = t.entities
    .ofTypes('automationEvent')
    .get()
    .filter((event) => event.fields.collection.value.entityId === collectionId)
  if (events.length !== 2) return null

  const startEvents = events.filter((event) =>
    event.fields.positionTicks.value === 0
    && event.fields.value.value === 0
    && event.fields.interpolation.value === 2,
  )
  const terminalEvents = events.filter((event) =>
    event.fields.positionTicks.value > 0
    && event.fields.value.value === 1,
  )
  if (startEvents.length !== 1 || terminalEvents.length !== 1) return null
  return terminalEvents[0]
}

function reconstructDeckTempoFromSynchronizedRegion(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const projectBpm = normalizeBpm(currentProjectBpm)
  const sourceBpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
  const sampleDurationSeconds = deck.sampleMeta?.durationSeconds
  const region = deck.regionEntity
  if (
    !region
    || !isSupportedBpm(projectBpm)
    || !isSupportedBpm(sourceBpm)
    || !sampleDurationSeconds
  ) {
    renderTempoControls(deckIndex)
    return false
  }
  const nativeDurationTicks = secondsToTicks(sampleDurationSeconds, projectBpm)
  const terminalEvent = nexus
    ? getExpectedPlaybackTerminalEvent({ entities: nexus.queryEntities }, region)
    : null
  const synchronizedDurationTicks = terminalEvent?.fields.positionTicks.value
    ?? (deckIndex < 2
      ? region.fields.region.fields.durationTicks.value
      : region.fields.region.fields.loopDurationTicks.value)
  if (
    !Number.isFinite(nativeDurationTicks)
    || nativeDurationTicks <= 0
    || !Number.isFinite(synchronizedDurationTicks)
    || synchronizedDurationTicks <= 0
  ) {
    setTempoError(deckIndex, 'INVALID SYNCHRONIZED TIMING')
    renderTempoControls(deckIndex)
    return false
  }

  const percent = reconstructTempoPercent(nativeDurationTicks, synchronizedDurationTicks)
  const requiredRange = smallestTempoRange(percent)
  deck.tempoPercent = percent
  deck.playbackRate = tempoPercentToPlaybackRate(percent)
  if (requiredRange !== null && Math.abs(percent) > deck.tempoRange + 1e-9) {
    deck.tempoRange = requiredRange
  }
  deck.lastAppliedTiming = {
    projectBpm,
    sourceBpm,
    percent,
    playbackRate: deck.playbackRate,
    mappedDurationTicks: synchronizedDurationTicks,
    regionDurationTicks: region.fields.region.fields.durationTicks.value,
  }
  if (requiredRange === null) {
    setTempoError(deckIndex, 'PROJECT TIMING EXCEEDS ±50%')
  } else {
    clearTempoError(deckIndex)
  }
  renderTempoControls(deckIndex)
  return true
}

function scheduleDeckTimingReconstruction(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  if (deck.tempoReconcileScheduled) return
  deck.tempoReconcileScheduled = true
  queueMicrotask(() => {
    deck.tempoReconcileScheduled = false
    if (!canUseDeckTempo(deckIndex)) return
    if (deck.tempoUpdatePending) return
    reconstructDeckTempoFromSynchronizedRegion(deckIndex)
    if (!deck.tempoSync) return
    const sourceBpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
    const projectBpm = normalizeBpm(currentProjectBpm)
    if (!isSupportedBpm(sourceBpm) || !isSupportedBpm(projectBpm)) return
    const targetPercent = tempoPercentForBpm(sourceBpm, projectBpm)
    const targetRange = smallestTempoRange(targetPercent)
    if (targetRange === null) {
      setTempoError(deckIndex, 'SYNC TARGET EXCEEDS ±50%')
      return
    }
    deck.tempoRange = targetRange
    if (Math.abs(deck.tempoPercent - targetPercent) > 0.01) {
      deck.tempoPercent = targetPercent
      renderTempoControls(deckIndex)
      queueDeckTempoUpdate(deckIndex, targetPercent)
    }
  })
}

function replaceSourceRegionWithNativeTiming(
  t: SafeTransactionBuilder,
  region: NexusEntity<'audioRegion'>,
  durationTicks: number,
  guardedIds: string[],
  regionDurationTicks = durationTicks,
) {
  const oldCollectionId = region.fields.playbackAutomationCollection.value.entityId
  const oldCollection = t.entities.ofTypes('automationCollection').getEntity(oldCollectionId)
  const oldEvents = t.entities
    .ofTypes('automationEvent')
    .get()
    .filter((event) => event.fields.collection.value.entityId === oldCollectionId)
  const oldCollectionRegionUsers = t.entities
    .ofTypes('audioRegion')
    .get()
    .filter((candidate) =>
      candidate.fields.playbackAutomationCollection.value.entityId === oldCollectionId,
    )

  const automationCollection = t.create('automationCollection', {})
  t.create('automationEvent', {
    collection: automationCollection.location,
    positionTicks: 0,
    value: 0,
    interpolation: 2,
  })
  t.create('automationEvent', {
    collection: automationCollection.location,
    positionTicks: durationTicks,
    value: 1,
  })
  const replacementRegion = t.create('audioRegion', {
    track: region.fields.track.value,
    playbackAutomationCollection: automationCollection.location,
    sample: region.fields.sample.value,
    region: {
      positionTicks: region.fields.region.fields.positionTicks.value,
      durationTicks: regionDurationTicks,
      collectionOffsetTicks: region.fields.region.fields.collectionOffsetTicks.value,
      loopOffsetTicks: region.fields.region.fields.loopOffsetTicks.value,
      loopDurationTicks: durationTicks,
      isEnabled: region.fields.region.fields.isEnabled.value,
      colorIndex: region.fields.region.fields.colorIndex.value,
      displayName: region.fields.region.fields.displayName.value,
    },
    gain: region.fields.gain.value,
    fadeInDurationTicks: region.fields.fadeInDurationTicks.value,
    fadeInSlope: region.fields.fadeInSlope.value,
    fadeOutDurationTicks: region.fields.fadeOutDurationTicks.value,
    fadeOutSlope: region.fields.fadeOutSlope.value,
    timestretchMode: 2,
    pitchShiftSemitones: region.fields.pitchShiftSemitones.value,
  })

  guardedRegionRemovalIds.add(region.id)
  guardedIds.push(region.id)
  t.remove(region)
  if (
    oldCollection
    && oldCollectionRegionUsers.length === 1
    && oldCollectionRegionUsers[0].id === region.id
  ) {
    oldEvents.forEach((event) => t.remove(event))
    t.remove(oldCollection)
  }
  return { region: replacementRegion, automationCollection }
}

function applyNativeSourceTiming(
  t: SafeTransactionBuilder,
  region: NexusEntity<'audioRegion'>,
  sampleDurationSeconds: number,
  projectBpm: number,
  guardedIds: string[],
  percent = 0,
): NativeTimingResult {
  const nativeDurationTicks = secondsToTicks(sampleDurationSeconds, projectBpm)
  if (!Number.isFinite(nativeDurationTicks) || nativeDurationTicks <= 0) {
    throw new Error('The source duration could not be converted to project ticks')
  }
  const durationTicks = mappedDurationTicks(nativeDurationTicks, percent)

  const terminalEvent = getExpectedPlaybackTerminalEvent(t, region)
  if (!terminalEvent) {
    const replacement = replaceSourceRegionWithNativeTiming(
      t,
      region,
      durationTicks,
      guardedIds,
    )
    return { durationTicks, replacementRegion: replacement.region }
  }

  const previousFullDurationTicks = terminalEvent.fields.positionTicks.value
  const contiguousRegions = contiguousAudioRegions(t.entities, region)
  const firstRegion = contiguousRegions[0] ?? region
  const firstFields = firstRegion.fields.region.fields
  const currentRegionDurationTicks = audioRegionChainDuration(contiguousRegions)
    || region.fields.region.fields.durationTicks.value
  const timingPlan = planSourceInstanceTimingResize({
    positionTicks: firstFields.positionTicks.value,
    durationTicks: currentRegionDurationTicks,
    collectionOffsetTicks: firstFields.collectionOffsetTicks.value,
    loopOffsetTicks: firstFields.loopOffsetTicks.value,
    loopDurationTicks: firstFields.loopDurationTicks.value,
    previousFullDurationTicks,
    nextFullDurationTicks: durationTicks,
  })
  if (contiguousRegions.length > 1) {
    resizeContiguousAudioRegions(
      t,
      contiguousRegions,
      previousFullDurationTicks,
      durationTicks,
      timingPlan.durationTicks,
      timingPlan.positionTicks,
    )
    t.update(terminalEvent.fields.positionTicks, durationTicks)
    contiguousRegions.forEach((candidate) => {
      t.update(candidate.fields.timestretchMode, 2)
    })
    return { durationTicks, replacementRegion: null, regionDurationTicks: timingPlan.durationTicks }
  }
  t.update(region.fields.region.fields.durationTicks, timingPlan.durationTicks)
  t.update(region.fields.region.fields.collectionOffsetTicks, timingPlan.collectionOffsetTicks)
  t.update(region.fields.region.fields.loopOffsetTicks, timingPlan.loopOffsetTicks)
  t.update(region.fields.region.fields.loopDurationTicks, timingPlan.loopDurationTicks)
  t.update(terminalEvent.fields.positionTicks, durationTicks)
  t.update(region.fields.timestretchMode, 2)
  if (region.fields.fadeInDurationTicks.value > timingPlan.durationTicks) {
    t.update(region.fields.fadeInDurationTicks, timingPlan.durationTicks)
  }
  const maximumFadeOutTicks = Math.max(
    0,
    timingPlan.durationTicks
      - Math.min(region.fields.fadeInDurationTicks.value, timingPlan.durationTicks),
  )
  if (region.fields.fadeOutDurationTicks.value > maximumFadeOutTicks) {
    t.update(region.fields.fadeOutDurationTicks, maximumFadeOutTicks)
  }
  return { durationTicks, replacementRegion: null, regionDurationTicks: timingPlan.durationTicks }
}

function applySourceDeckInstancesTiming(
  t: SafeTransactionBuilder,
  deckIndex: 0 | 1,
  controlledRegion: NexusEntity<'audioRegion'>,
  sampleDurationSeconds: number,
  projectBpm: number,
  guardedIds: string[],
  percent: number,
): NativeTimingResult {
  const instances = sourceDeckInstances(t.entities, deckIndex, controlledRegion)
  let controlledInstanceId = instances.find((instance) =>
    contiguousAudioRegions(t.entities, instance)
      .some((candidate) => candidate.id === controlledRegion.id))?.id
  if (!controlledInstanceId) {
    instances.push(controlledRegion)
    controlledInstanceId = controlledRegion.id
  }
  let controlledRegionDurationTicks = controlledRegion.fields.region.fields.durationTicks.value
  const replacements: SourceTimingReplacement[] = []
  let durationTicks = 0
  instances.forEach((instance) => {
    const result = applyNativeSourceTiming(
      t,
      instance,
      sampleDurationSeconds,
      projectBpm,
      guardedIds,
      percent,
    )
    durationTicks = result.durationTicks
    if (instance.id === controlledInstanceId) {
      controlledRegionDurationTicks = result.regionDurationTicks
        ?? result.replacementRegion?.fields.region.fields.durationTicks.value
        ?? controlledRegionDurationTicks
    }
    if (!result.replacementRegion) return
    const automationCollection = t.entities
      .ofTypes('automationCollection')
      .getEntity(result.replacementRegion.fields.playbackAutomationCollection.value.entityId)
    if (!automationCollection) throw new Error('Replacement automation collection was not found')
    replacements.push({
      deckIndex,
      previousRegionId: instance.id === controlledInstanceId
        ? controlledRegion.id
        : instance.id,
      region: result.replacementRegion,
      automationCollection,
    })
  })
  return {
    durationTicks,
    replacementRegion: null,
    controlledRegionDurationTicks,
    replacements,
  }
}

function applyMagicTempoTiming(
  t: SafeTransactionBuilder,
  region: NexusEntity<'audioRegion'>,
  sampleDurationSeconds: number,
  projectBpm: number,
  guardedIds: string[],
  percent: number,
  regionDurationTicksOverride?: number,
): NativeTimingResult {
  const nativeDurationTicks = secondsToTicks(sampleDurationSeconds, projectBpm)
  if (!Number.isFinite(nativeDurationTicks) || nativeDurationTicks <= 0) {
    throw new Error('The Magic sample duration could not be converted to project ticks')
  }
  const durationTicks = mappedDurationTicks(nativeDurationTicks, percent)
  const regionDurationTicks =
    regionDurationTicksOverride ?? region.fields.region.fields.durationTicks.value
  const terminalEvent = getExpectedPlaybackTerminalEvent(t, region)
  if (!terminalEvent) {
    const replacement = replaceSourceRegionWithNativeTiming(
      t,
      region,
      durationTicks,
      guardedIds,
      regionDurationTicks,
    )
    return { durationTicks, replacementRegion: replacement.region }
  }

  const previousFullDurationTicks = terminalEvent.fields.positionTicks.value
  const contiguousRegions = contiguousAudioRegions(t.entities, region)
  if (contiguousRegions.length > 1) {
    resizeContiguousAudioRegions(
      t,
      contiguousRegions,
      previousFullDurationTicks,
      durationTicks,
      regionDurationTicks,
    )
    t.update(terminalEvent.fields.positionTicks, durationTicks)
    contiguousRegions.forEach((candidate) => {
      t.update(candidate.fields.timestretchMode, 2)
    })
    return { durationTicks, replacementRegion: null }
  }

  if (
    regionDurationTicksOverride !== undefined
    && region.fields.region.fields.durationTicks.value !== regionDurationTicksOverride
  ) {
    t.update(region.fields.region.fields.durationTicks, regionDurationTicksOverride)
  }
  t.update(region.fields.region.fields.loopDurationTicks, durationTicks)
  t.update(terminalEvent.fields.positionTicks, durationTicks)
  t.update(region.fields.timestretchMode, 2)
  return { durationTicks, replacementRegion: null }
}

function rebindSourceTimingReplacements(
  replacements: SourceTimingReplacement[],
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  replacements.forEach((replacement) => {
    const deck = decks[replacement.deckIndex]
    if (
      deck.regionEntity?.id !== replacement.previousRegionId
      || !deck.trackEntity
    ) return
    deck.contentSubscriptions.forEach((subscription) => subscription.terminate())
    deck.contentSubscriptions = []
    deck.regionEntity = replacement.region
    deck.automationCollectionEntity = replacement.automationCollection
    if (replacement.deckIndex < 2) {
      watchSourceDeckContent(
        replacement.deckIndex as 0 | 1,
        projectDocument,
        replacement.region,
        expectedSession,
      )
    } else {
      watchMagicDeckContent(projectDocument, replacement.region, expectedSession)
    }
    renderTempoControls(replacement.deckIndex)
    if (replacement.deckIndex < 2) {
      updateManualBpmReportUi(replacement.deckIndex as 0 | 1)
    }
  })
}

async function applyDeckTempoUpdate(
  deckIndex: WaveformDeckIndex,
  percent: number,
  expectedSession: number,
) {
  return serializeSourceTiming(async () => {
    const deck = decks[deckIndex]
    const projectDocument = nexus
    const regionId = deck.regionEntity?.id
    const sampleDurationSeconds = deck.sampleMeta?.durationSeconds
    const sourceBpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
    const projectBpm = normalizeBpm(currentProjectBpm)
    if (
      !projectDocument
      || !projectConnected
      || !regionId
      || !sampleDurationSeconds
      || !isSupportedBpm(sourceBpm)
      || !isSupportedBpm(projectBpm)
    ) throw new Error('The synchronized deck timing is no longer available')

    const guardedIds: string[] = []
    try {
      const transactionResult = await projectDocument.modify((t) => {
        const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
        if (!region) throw new Error('The project region is no longer available')
        const magicStopEndTicks = deckIndex < 2
          ? getMagicScheduledStopEndTicks(t)
          : null
        const timingResult = deckIndex < 2
          ? applySourceDeckInstancesTiming(
              t,
              deckIndex as 0 | 1,
              region,
              sampleDurationSeconds,
              projectBpm,
              guardedIds,
              percent,
            )
          : applyMagicTempoTiming(
              t,
              region,
              sampleDurationSeconds,
              projectBpm,
              guardedIds,
              percent,
            )
        const replacements: SourceTimingReplacement[] = deckIndex < 2
          ? timingResult.replacements ?? []
          : []
        if (deckIndex === 2 && timingResult.replacementRegion) {
          const automationCollection = t.entities
            .ofTypes('automationCollection')
            .getEntity(timingResult.replacementRegion.fields.playbackAutomationCollection.value.entityId)
          if (!automationCollection) throw new Error('Replacement automation collection was not found')
          replacements.push({
            deckIndex,
            previousRegionId: regionId,
            region: timingResult.replacementRegion,
            automationCollection,
          })
        }
        if (deckIndex < 2) {
          updateMagicLoopDurationInTransaction(
            t,
            new Map([[regionId, timingResult.durationTicks]]),
            undefined,
            magicStopEndTicks,
          )
        }
        return {
          replacements,
          mappedDurationTicks: timingResult.durationTicks,
          regionDurationTicks: deckIndex < 2
            ? timingResult.controlledRegionDurationTicks
              ?? region.fields.region.fields.durationTicks.value
            : region.fields.region.fields.durationTicks.value,
        }
      })
      if (
        nexus !== projectDocument
        || !projectConnected
        || expectedSession !== tempoSessionId
        || deck.regionEntity?.id !== regionId
      ) throw new Error('The project connection or region changed during the tempo update')

      rebindSourceTimingReplacements(
        transactionResult.replacements,
        projectDocument,
        expectedSession,
      )
      const appliedPlaybackRate = tempoPercentToPlaybackRate(percent)
      if (deck.pendingTempoPercent === null) {
        deck.tempoPercent = percent
        deck.playbackRate = appliedPlaybackRate
      }
      deck.lastAppliedTiming = {
        projectBpm,
        sourceBpm,
        percent,
        playbackRate: appliedPlaybackRate,
        mappedDurationTicks: transactionResult.mappedDurationTicks,
        regionDurationTicks: transactionResult.regionDurationTicks,
      }
      renderTempoControls(deckIndex)
    } finally {
      guardedIds.forEach((regionIdToRelease) => guardedRegionRemovalIds.delete(regionIdToRelease))
    }
  })
}

function queueDeckTempoUpdate(deckIndex: WaveformDeckIndex, percent: number) {
  const deck = decks[deckIndex]
  deck.pendingTempoPercent = percent
  if (deck.tempoWorker) return
  const expectedSession = tempoSessionId
  deck.tempoUpdatePending = true
  renderTempoControls(deckIndex)

  const worker = (async () => {
    while (
      expectedSession === tempoSessionId
      && nexus !== null
      && deck.pendingTempoPercent !== null
    ) {
      const nextPercent = deck.pendingTempoPercent
      deck.pendingTempoPercent = null
      try {
        await applyDeckTempoUpdate(deckIndex, nextPercent, expectedSession)
        clearTempoError(deckIndex)
      } catch (error) {
        if (expectedSession !== tempoSessionId) return
        deck.pendingTempoPercent = null
        reconstructDeckTempoFromSynchronizedRegion(deckIndex)
        const message = error instanceof Error ? error.message : String(error)
        setTempoError(deckIndex, `UPDATE FAILED: ${message}`)
        setStatus('error', `DECK ${deckIndex + 1}: TEMPO UPDATE FAILED — ${message}`)
        return
      }
    }
  })()
  deck.tempoWorker = worker
  void worker.finally(() => {
    if (deck.tempoWorker !== worker) return
    deck.tempoWorker = null
    deck.tempoUpdatePending = false
    renderTempoControls(deckIndex)
    if (
      deck.pendingTempoPercent !== null
      && expectedSession === tempoSessionId
      && nexus !== null
    ) queueDeckTempoUpdate(deckIndex, deck.pendingTempoPercent)
  })
}

function updateMagicLoopDurationInTransaction(
  t: SafeTransactionBuilder,
  durationOverrides?: ReadonlyMap<string, number>,
  durationTicksOverride?: number,
  preservedStopEndTicks?: number | null,
) {
  const magicRegionId = decks[2].regionEntity?.id
  if (!magicRegionId) return
  const magicRegion = t.entities.ofTypes('audioRegion').getEntity(magicRegionId)
  if (!magicRegion) return
  const durationTicks = durationTicksOverride
    ?? getMagicLoopDurationTicks(t, durationOverrides)
  const magicRegions = contiguousAudioRegions(t.entities, magicRegion)
  const currentRegionDurationTicks = audioRegionChainDuration(magicRegions)
  const regionDurationTicks = preservedStopEndTicks === null || preservedStopEndTicks === undefined
    ? durationTicks
    : Math.min(
        durationTicks,
        Math.max(0, preservedStopEndTicks - magicRegion.fields.region.fields.positionTicks.value),
      )
  if (currentRegionDurationTicks !== regionDurationTicks) {
    updateDeckRegionChainTiming(
      t,
      magicRegion,
      magicRegions[0]?.fields.region.fields.positionTicks.value
        ?? magicRegion.fields.region.fields.positionTicks.value,
      regionDurationTicks,
    )
  }
  magicRegions.forEach((region) => {
    if (region.fields.timestretchMode.value !== 2) {
      t.update(region.fields.timestretchMode, 2)
    }
  })
}

function getMagicScheduledStopEndTicks(t: SafeTransactionBuilder) {
  const magicRegionId = decks[2].regionEntity?.id
  if (!magicRegionId) return null
  const magicRegion = t.entities.ofTypes('audioRegion').getEntity(magicRegionId)
  if (!magicRegion || !magicRegion.fields.region.fields.isEnabled.value) return null
  const magicRegions = contiguousAudioRegions(t.entities, magicRegion)
  const fullDurationTicks = getMagicLoopDurationTicks(t)
  const durationTicks = audioRegionChainDuration(magicRegions)
  return durationTicks < fullDurationTicks
    ? (magicRegions[0]?.fields.region.fields.positionTicks.value
        ?? magicRegion.fields.region.fields.positionTicks.value) + durationTicks
    : null
}

async function remapLoadedSourceRegions(
  projectDocument: SyncedDocument,
  projectBpm: number,
  expectedSession: number,
) {
  const rejected: WaveformDeckIndex[] = []
  const sources = decks.flatMap((deck, deckIndexValue) => {
    const deckIndex = deckIndexValue as WaveformDeckIndex
    if (!deck.regionEntity || !deck.sampleMeta) return []
    const sourceBpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
    if (!isSupportedBpm(sourceBpm)) return []
    const desiredPercent = deck.tempoSync
      ? tempoPercentForBpm(sourceBpm, projectBpm)
      : deck.tempoPercent
    if (smallestTempoRange(desiredPercent) === null) {
      if (deck.tempoSync) rejected.push(deckIndex)
      return []
    }
    return [{
      deckIndex,
      regionId: deck.regionEntity.id,
      sampleDurationSeconds: deck.sampleMeta.durationSeconds,
      sourceBpm,
      desiredPercent,
    }]
  })
  const guardedIds: string[] = []
  try {
    const transactionResult = await projectDocument.modify((t) => {
      const config = t.entities.ofTypes('config').get()[0]
      const currentTempo = Number(config?.fields.tempoBpm.value)
      if (!Number.isFinite(currentTempo) || Math.abs(currentTempo - projectBpm) > 0.0001) {
        return {
          applied: false,
          replacements: [] as SourceTimingReplacement[],
          timings: [] as Array<{
            deckIndex: WaveformDeckIndex
            mappedDurationTicks: number
            regionDurationTicks: number
          }>,
        }
      }
      const nextReplacements: SourceTimingReplacement[] = []
      const timings: Array<{
        deckIndex: WaveformDeckIndex
        mappedDurationTicks: number
        regionDurationTicks: number
      }> = []
      const durationOverrides = new Map<string, number>()
      const magicStopEndTicks = getMagicScheduledStopEndTicks(t)
      sources.forEach((source) => {
        const region = t.entities.ofTypes('audioRegion').getEntity(source.regionId)
        if (!region) throw new Error(`Deck ${source.deckIndex + 1} project region was not found`)
        const result = source.deckIndex < 2
          ? applySourceDeckInstancesTiming(
              t,
              source.deckIndex as 0 | 1,
              region,
              source.sampleDurationSeconds,
              projectBpm,
              guardedIds,
              source.desiredPercent,
            )
          : applyMagicTempoTiming(
              t,
              region,
              source.sampleDurationSeconds,
              projectBpm,
              guardedIds,
              source.desiredPercent,
              getMagicLoopDurationTicks(t, durationOverrides),
            )
        if (source.deckIndex < 2) {
          durationOverrides.set(source.regionId, result.durationTicks)
        }
        timings.push({
          deckIndex: source.deckIndex,
          mappedDurationTicks: result.durationTicks,
          regionDurationTicks: source.deckIndex < 2
            ? result.controlledRegionDurationTicks
              ?? region.fields.region.fields.durationTicks.value
            : getMagicLoopDurationTicks(t, durationOverrides),
        })
        if (source.deckIndex < 2) {
          nextReplacements.push(...(result.replacements ?? []))
        } else if (result.replacementRegion) {
          const automationCollection = t.entities
            .ofTypes('automationCollection')
            .getEntity(result.replacementRegion.fields.playbackAutomationCollection.value.entityId)
          if (!automationCollection) throw new Error('Replacement automation collection was not found')
          nextReplacements.push({
            deckIndex: source.deckIndex,
            previousRegionId: source.regionId,
            region: result.replacementRegion,
            automationCollection,
          })
        }
      })
      updateMagicLoopDurationInTransaction(
        t,
        durationOverrides,
        undefined,
        magicStopEndTicks,
      )
      return { applied: true, replacements: nextReplacements, timings }
    })
    if (!transactionResult.applied) return { applied: false, rejected }
    if (nexus !== projectDocument || expectedSession !== tempoSessionId) {
      throw new Error('The project connection changed during the tempo remap')
    }
    rebindSourceTimingReplacements(
      transactionResult.replacements,
      projectDocument,
      expectedSession,
    )
    transactionResult.timings.forEach((timing) => {
      const source = sources.find((candidate) => candidate.deckIndex === timing.deckIndex)
      if (!source) return
      const deck = decks[timing.deckIndex]
      deck.tempoPercent = source.desiredPercent
      deck.playbackRate = tempoPercentToPlaybackRate(source.desiredPercent)
      if (deck.tempoSync) {
        deck.tempoRange = smallestTempoRange(source.desiredPercent) ?? deck.tempoRange
      }
      deck.lastAppliedTiming = {
        projectBpm,
        sourceBpm: source.sourceBpm,
        percent: source.desiredPercent,
        playbackRate: deck.playbackRate,
        mappedDurationTicks: timing.mappedDurationTicks,
        regionDurationTicks: timing.regionDurationTicks,
      }
      clearTempoError(timing.deckIndex)
      renderTempoControls(timing.deckIndex)
    })
    return { applied: true, rejected }
  } finally {
    guardedIds.forEach((regionId) => guardedRegionRemovalIds.delete(regionId))
  }
}

async function applyManualSourceBpm(deckIndex: 0 | 1, correctedBpm: number) {
  return serializeSourceTiming(async () => {
    const deck = decks[deckIndex]
    const projectDocument = nexus
    const regionId = deck.regionEntity?.id
    const sampleDurationSeconds = deck.sampleMeta?.durationSeconds
    const expectedSession = tempoSessionId
    if (!projectDocument || !projectConnected || !regionId || !sampleDurationSeconds) {
      throw new Error('The project region or uploaded sample is no longer available')
    }

    const guardedIds: string[] = []
    try {
      const transactionResult = await projectDocument.modify((t) => {
        const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
        if (!region) throw new Error('The project region is no longer available')
        const magicStopEndTicks = getMagicScheduledStopEndTicks(t)
        const sourceDeckCount = loadedSourceDeckCount(t)
        if (sourceDeckCount < 1) throw new Error('No loaded source region was found')
        const projectTempoUpdated = sourceDeckCount === 1
        const config = t.entities.ofTypes('config').get()[0]
        if (!config) throw new Error('Project tempo configuration was not found')
        const effectiveProjectBpm = projectTempoUpdated
          ? correctedBpm
          : Number(config.fields.tempoBpm.value)
        if (
          !Number.isFinite(effectiveProjectBpm)
          || effectiveProjectBpm < MIN_SUPPORTED_BPM
          || effectiveProjectBpm > MAX_SUPPORTED_BPM
        ) {
          throw new Error('Project tempo is outside the supported range')
        }
        if (projectTempoUpdated) {
          t.update(config.fields.tempoBpm, correctedBpm)
        }
        const desiredPercent = deck.tempoSync
          ? tempoPercentForBpm(correctedBpm, effectiveProjectBpm)
          : deck.tempoPercent
        if (smallestTempoRange(desiredPercent) === null) {
          throw new Error('The corrected BPM requires a tempo change beyond ±50%')
        }

        const timingResult = applySourceDeckInstancesTiming(
          t,
          deckIndex,
          region,
          sampleDurationSeconds,
          effectiveProjectBpm,
          guardedIds,
          desiredPercent,
        )
        const replacements = timingResult.replacements ?? []
        updateMagicLoopDurationInTransaction(
          t,
          new Map([[regionId, timingResult.durationTicks]]),
          undefined,
          magicStopEndTicks,
        )
        return {
          projectTempoUpdated,
          replacements,
          desiredPercent,
          mappedDurationTicks: timingResult.durationTicks,
          regionDurationTicks: timingResult.controlledRegionDurationTicks
            ?? region.fields.region.fields.durationTicks.value,
          projectBpm: effectiveProjectBpm,
        }
      })

      if (
        nexus !== projectDocument
        || !projectConnected
        || expectedSession !== tempoSessionId
        || deck.regionEntity?.id !== regionId
      ) {
        throw new Error('The project connection or region changed during the BPM update')
      }

      rebindSourceTimingReplacements(
        transactionResult.replacements,
        projectDocument,
        expectedSession,
      )
      deck.sampleBpm = correctedBpm
      deck.baseBpm = correctedBpm
      deck.tempoPercent = transactionResult.desiredPercent
      deck.playbackRate = tempoPercentToPlaybackRate(transactionResult.desiredPercent)
      if (deck.tempoSync) {
        deck.tempoRange =
          smallestTempoRange(transactionResult.desiredPercent) ?? deck.tempoRange
      }
      deck.lastAppliedTiming = {
        projectBpm: transactionResult.projectBpm,
        sourceBpm: correctedBpm,
        percent: transactionResult.desiredPercent,
        playbackRate: deck.playbackRate,
        mappedDurationTicks: transactionResult.mappedDurationTicks,
        regionDurationTicks: transactionResult.regionDurationTicks,
      }
      if (transactionResult.projectTempoUpdated) {
        updateDeckBpmLabels(correctedBpm)
      } else {
        renderTempoControls(deckIndex)
      }
      return transactionResult.projectTempoUpdated
    } finally {
      guardedIds.forEach((guardedId) => guardedRegionRemovalIds.delete(guardedId))
    }
  })
}

function setupManualBpmReport(deckIndex: 0 | 1) {
  const state = manualBpmReportStates[deckIndex]
  const controls = getManualBpmReportElements(deckIndex)
  const deckNum = deckIndex + 1

  controls.trigger.onclick = () => {
    const bpm = normalizeBpm(decks[deckIndex].sampleBpm ?? decks[deckIndex].baseBpm)
    if (!canReportManualBpm(deckIndex) || !isSupportedBpm(bpm)) {
      setStatus('error', `DECK ${deckNum}: SOURCE BPM CANNOT BE REPORTED WITHOUT AN ACTIVE PROJECT REGION`)
      updateManualBpmReportUi(deckIndex)
      return
    }
    state.editing = true
    controls.input.value = String(bpm)
    controls.error.textContent = ''
    updateManualBpmReportUi(deckIndex)
    controls.input.focus()
    controls.input.select()
  }

  controls.cancel.onclick = () => resetManualBpmReport(deckIndex)
  controls.input.oninput = () => { controls.error.textContent = '' }

  const submit = async () => {
    if (state.pending) return
    const enteredBpm = Number(controls.input.value)
    const bpm = Number.isInteger(enteredBpm) ? enteredBpm : null
    if (!isSupportedBpm(bpm)) {
      controls.error.textContent =
        `BPM MUST BE A WHOLE NUMBER BETWEEN ${MIN_SUPPORTED_BPM} AND ${MAX_SUPPORTED_BPM}`
      controls.input.focus()
      return
    }

    const requestId = state.requestId + 1
    state.requestId = requestId
    state.pending = true
    controls.error.textContent = ''
    updateManualBpmReportUi(deckIndex)
    setStatus('connecting', `DECK ${deckNum}: APPLYING CORRECTED SOURCE BPM ${bpm}…`)

    try {
      const projectTempoUpdated = await applyManualSourceBpm(deckIndex, bpm)
      if (state.requestId !== requestId) return
      state.editing = false
      setStatus('connected', projectTempoUpdated
        ? `DECK ${deckNum}: SOURCE BPM CORRECTED TO ${bpm} — PROJECT TEMPO UPDATED, NATIVE SPEED PRESERVED ✓`
        : `DECK ${deckNum}: SOURCE BPM CORRECTED TO ${bpm} — NATIVE SPEED PRESERVED ✓`)
    } catch (error) {
      if (state.requestId !== requestId) return
      const message = error instanceof Error ? error.message : String(error)
      controls.error.textContent = `UPDATE FAILED: ${message.toUpperCase()}`
      setStatus('error', `DECK ${deckNum}: BPM UPDATE FAILED — ${message}`)
    } finally {
      if (state.requestId === requestId) {
        state.pending = false
        updateManualBpmReportUi(deckIndex)
      }
    }
  }

  controls.apply.onclick = () => { void submit() }
  controls.input.onkeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape' && !state.pending) {
      event.preventDefault()
      resetManualBpmReport(deckIndex)
    }
  }
  resetManualBpmReport(deckIndex)
}

function resetBpmDialogue(deckIndex: number) {
  const prefix = `deck${deckIndex + 1}-bpm`
  el<HTMLDivElement>(`${prefix}-dialogue`).classList.remove('is-hidden')
  el<HTMLDivElement>(`${prefix}-form`).classList.add('is-hidden')
  const title = el<HTMLDivElement>(`${prefix}-title`)
  title.textContent = DECK_PROMPT_IDLE_TEXT
  title.classList.add('bpm-dialogue-title-idle')
}

function showBpmAnalyzing(deckNum: number) {
  if (activeLibraryDeckIndex !== null) closeDeckLibraryAssistant(false)
  const prefix = `deck${deckNum}-bpm`
  el<HTMLDivElement>(`${prefix}-dialogue`).classList.remove('is-hidden')
  el<HTMLDivElement>(`${prefix}-form`).classList.add('is-hidden')
  const title = el<HTMLDivElement>(`${prefix}-title`)
  title.textContent = 'ANALYZING BPM…'
  title.classList.remove('bpm-dialogue-title-idle')
}

function showBpmDialogue(deckNum: number, estimate?: AubioBpmResult): Promise<BpmResolution | null> {
  if (activeLibraryDeckIndex !== null) closeDeckLibraryAssistant(false)
  return new Promise((resolve) => {
    const deckIndex = deckNum - 1
    const prefix = `deck${deckNum}-bpm`
    const dialogue = el<HTMLDivElement>(`${prefix}-dialogue`)
    const form = el<HTMLDivElement>(`${prefix}-form`)
    const input = el<HTMLInputElement>(`${prefix}-input`)
    const confirm = el<HTMLButtonElement>(`${prefix}-accept`)
    const fallback = el<HTMLButtonElement>(`${prefix}-skip`)
    const hint = el<HTMLDivElement>(`${prefix}-hint`)
    const error = el<HTMLDivElement>(`${prefix}-error`)
    const detectedBpm = normalizeBpm(estimate?.bpm)
    const confidencePercent = Math.round((estimate?.confidence ?? 0) * 100)
    input.value = isSupportedBpm(detectedBpm) ? String(detectedBpm) : ''
    hint.textContent = isSupportedBpm(detectedBpm)
      ? `AUBIO: ${detectedBpm} BPM · ${confidencePercent}% CONFIDENCE`
      : 'ENTER SOURCE BPM (40–240)'
    error.textContent = ''
    const title = el<HTMLDivElement>(`${prefix}-title`)
    title.textContent = 'CONFIRM SOURCE BPM'
    title.classList.remove('bpm-dialogue-title-idle')
    dialogue.classList.remove('is-hidden')
    form.classList.remove('is-hidden')

    const close = (result: BpmResolution | null) => {
      resetBpmDialogue(deckIndex)
      confirm.onclick = null
      fallback.onclick = null
      input.onkeydown = null
      pendingBpmResolutions[deckIndex] = null
      resolve(result)
    }
    pendingBpmResolutions[deckIndex] = close
    const submit = () => {
      const bpm = normalizeBpm(Number(input.value))
      if (!isSupportedBpm(bpm)) {
        error.textContent = `BPM MUST BE BETWEEN ${MIN_SUPPORTED_BPM} AND ${MAX_SUPPORTED_BPM}`
        return
      }
      close({ bpm, source: 'manual' })
    }
    input.onkeydown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') { event.preventDefault(); submit() }
    }
    confirm.onclick = submit
    fallback.onclick = () => {
      const projectBpm = normalizeBpm(currentProjectBpm)
      if (!isSupportedBpm(projectBpm)) {
        error.textContent = `PROJECT BPM IS NOT AVAILABLE IN THE ${MIN_SUPPORTED_BPM}–${MAX_SUPPORTED_BPM} RANGE`
        return
      }
      close({ bpm: projectBpm, source: 'project' })
    }
  })
}

async function requestAubioBpm(file: File): Promise<AubioBpmResult> {
  const form = new FormData()
  form.append('audio_file', file, file.name)
  const response = await fetch(`${magentaEndpoint()}/detect-bpm`, { method: 'POST', body: form })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(body?.detail || `BPM analysis failed (${response.status})`)
  }
  return await response.json() as AubioBpmResult
}

async function resolveSampleBpm(sample: SampleMeta, file: File, deckNum: number, expectedSession: number): Promise<BpmResolution | null> {
  const metadataBpm = normalizeBpm(sample.bpm)
  if (isSupportedBpm(metadataBpm)) {
    resetBpmDialogue(deckNum - 1)
    setStatus('connected', `DECK ${deckNum}: AUDIOTOOL BPM METADATA ${metadataBpm} ACCEPTED`)
    return { bpm: metadataBpm, source: 'audiotool' }
  }
  showBpmAnalyzing(deckNum)
  setStatus('connecting', `DECK ${deckNum}: ANALYZING BPM WITH AUBIO…`)
  try {
    const estimate = await requestAubioBpm(file)
    const normalizedEstimate = { ...estimate, bpm: normalizeBpm(estimate.bpm) }
    if (expectedSession !== tempoSessionId || !nexus) {
      resetBpmDialogue(deckNum - 1)
      return null
    }
    if (normalizedEstimate.confidence > AUBIO_AUTO_ACCEPT_CONFIDENCE && isSupportedBpm(normalizedEstimate.bpm)) {
      resetBpmDialogue(deckNum - 1)
      setStatus('connected', `DECK ${deckNum}: AUBIO DETECTED ${normalizedEstimate.bpm} BPM (${Math.round(normalizedEstimate.confidence * 100)}% CONFIDENCE)`)
      return { bpm: normalizedEstimate.bpm, source: 'aubio' }
    }
    if (isSupportedBpm(normalizedEstimate.bpm)) {
      setStatus('connected', `DECK ${deckNum}: AUBIO ESTIMATE ${normalizedEstimate.bpm} BPM (${Math.round(normalizedEstimate.confidence * 100)}% CONFIDENCE) — CONFIRM BPM`)
    } else {
      setStatus('connected', `DECK ${deckNum}: AUBIO COULD NOT RESOLVE BPM — MANUAL ENTRY REQUIRED`)
    }
    return showBpmDialogue(deckNum, normalizedEstimate)
  } catch (e) {
    console.warn('[AUBIO] BPM analysis:', e)
    if (expectedSession !== tempoSessionId || !nexus) {
      resetBpmDialogue(deckNum - 1)
      return null
    }
    setStatus('connected', `DECK ${deckNum}: BPM ANALYSIS FAILED — MANUAL ENTRY REQUIRED`)
    return showBpmDialogue(deckNum)
  }
}

function knobValueToEqDb(value: number) {
  return Math.max(-18, Math.min(18, (value - 0.5) * 36))
}

async function uploadSample(
  file: File,
  displayName: string,
  bpm?: number,
  description?: string,
) {
  if (!at) throw new Error('Not logged in')
  const upload = await at.samples.upload({
    file,
    displayName,
    description,
    kind: 'loop',
    bpm,
  })
  if (upload instanceof Error) throw upload

  const uploaded = await upload.uploaded
  if (uploaded instanceof Error) throw uploaded

  const sample = await upload.ready
  if (sample instanceof Error) throw sample
  return sample
}

function resolveInsertedProjectEntities(region: NexusEntity<'audioRegion'>, t: SafeTransactionBuilder) {
  const trackId = region.fields.track.value.entityId
  const track = t.entities.ofTypes('audioTrack').getEntity(trackId)
  if (!track) throw new Error('Inserted audio track was not found')

  const sample = t.entities.ofTypes('sample').getEntity(region.fields.sample.value.entityId)
  if (!sample) throw new Error('Inserted sample entity was not found')

  const automationCollection = t.entities
    .ofTypes('automationCollection')
    .getEntity(region.fields.playbackAutomationCollection.value.entityId)
  if (!automationCollection) throw new Error('Inserted automation collection was not found')

  const audioDeviceId = track.fields.player.value.entityId
  const audioDevice = t.entities.ofTypes('audioDevice').getEntity(audioDeviceId)
  if (!audioDevice) throw new Error('Inserted audio device was not found')

  const routing = resolveDeckRoutingGraphs(t.entities, audioDevice)
    .find((candidate) => candidate.track.id === track.id)
  if (!routing) throw new Error('Inserted deck routing was not found')

  return { ...routing, sample, automationCollection }
}

function getMagicLoopDurationTicks(
  t: SafeTransactionBuilder,
  durationOverrides?: ReadonlyMap<string, number>,
) {
  return decks.slice(0, 2).reduce((durationTicks, deck) => {
    if (!deck.regionEntity) return durationTicks
    const durationOverride = durationOverrides?.get(deck.regionEntity.id)
    if (durationOverride !== undefined) {
      return Math.max(durationTicks, durationOverride)
    }
    const region = t.entities.ofTypes('audioRegion').getEntity(deck.regionEntity.id)
    if (!region) return durationTicks
    const terminalEvent = getExpectedPlaybackTerminalEvent(t, region)
    const fullDurationTicks = terminalEvent?.fields.positionTicks.value
      ?? region.fields.region.fields.loopDurationTicks.value
    return Math.max(durationTicks, fullDurationTicks)
  }, Ticks.Bars(MAGIC_DURATION_BARS))
}

function getDeckFullDurationTicks(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
  region: NexusEntity<'audioRegion'>,
) {
  if (deckIndex === 2) return getMagicLoopDurationTicks(t)
  const terminalEvent = getExpectedPlaybackTerminalEvent(t, region)
  if (!terminalEvent) {
    throw new Error('Deck playback automation is not in the expected synchronized form')
  }
  return terminalEvent.fields.positionTicks.value
}

function getSynchronizedDeckFullDurationTicks(deckIndex: WaveformDeckIndex) {
  const region = decks[deckIndex].regionEntity
  const projectDocument = nexus
  if (!region || !projectDocument) return null
  if (deckIndex === 2) {
    return decks.slice(0, 2).reduce((durationTicks, sourceDeck) => {
      const sourceRegion = sourceDeck.regionEntity
      if (!sourceRegion) return durationTicks
      const terminalEvent = getExpectedPlaybackTerminalEvent(
        { entities: projectDocument.queryEntities },
        sourceRegion,
      )
      return Math.max(
        durationTicks,
        terminalEvent?.fields.positionTicks.value
          ?? sourceRegion.fields.region.fields.loopDurationTicks.value,
      )
    }, Ticks.Bars(MAGIC_DURATION_BARS))
  }
  return getExpectedPlaybackTerminalEvent(
    { entities: projectDocument.queryEntities },
    region,
  )?.fields.positionTicks.value ?? null
}

function getDeckTransportElements(deckIndex: WaveformDeckIndex) {
  const prefix = `d${deckIndex + 1}`
  return {
    previous: el<HTMLButtonElement>(`${prefix}-launch-previous`),
    next: el<HTMLButtonElement>(`${prefix}-launch-next`),
    step: el<HTMLSelectElement>(`${prefix}-launch-step`),
    reenter: el<HTMLButtonElement>(`${prefix}-reenter`),
    crossfadeFrom: el<HTMLSelectElement>(`${prefix}-crossfade-from`),
    crossfadeBars: el<HTMLSelectElement>(`${prefix}-crossfade-bars`),
    cancel: el<HTMLButtonElement>(`${prefix}-cancel`),
    stop: el<HTMLButtonElement>(`${prefix}-stop-next-bar`),
    status: el<HTMLSpanElement>(`${prefix}-project-status`),
    error: el<HTMLDivElement>(`${prefix}-transport-error`),
  }
}

function renderDeckTransport(deckIndex: WaveformDeckIndex) {
  const controls = getDeckTransportElements(deckIndex)
  const operation = deckOperationStates[deckIndex]
  const region = decks[deckIndex].regionEntity
  const available = projectConnected && nexus !== null && region !== null
  const pending = operation.pendingCount > 0
  const outgoingValue = controls.crossfadeFrom.value
  const outgoingDeckIndex = outgoingValue === ''
    ? null
    : Number(outgoingValue) as WaveformDeckIndex
  const incomingAutomationBlocked = deckHasUserGainAutomation(deckIndex)
  const outgoingAutomationBlocked = outgoingDeckIndex === null
    ? false
    : deckHasUserGainAutomation(outgoingDeckIndex)
  if (outgoingAutomationBlocked) {
    controls.crossfadeFrom.value = ''
    controls.error.textContent =
      `${placementDeckLabel(outgoingDeckIndex!)} HAS USER GAIN AUTOMATION — ORDINARY LAUNCH REMAINS AVAILABLE`
  }
  controls.previous.disabled = !available || pending
  controls.next.disabled = !available || pending
  controls.step.disabled = !available || pending
  controls.reenter.disabled = !available || pending
  controls.crossfadeFrom.disabled = !available || pending || incomingAutomationBlocked
  controls.crossfadeBars.disabled = !available || pending || controls.crossfadeFrom.value === ''
  controls.crossfadeFrom.title = incomingAutomationBlocked
    ? 'Crossfade unavailable because this deck gain already has user automation'
    : ''
  controls.cancel.disabled = !available || pending || region?.fields.region.fields.isEnabled.value !== true
  controls.stop.disabled = !available || pending || region?.fields.region.fields.isEnabled.value !== true
  controls.cancel.textContent = pending && operation.activeKind === 'cancelling' ? 'CHECKING…' : 'CANCEL'
  controls.stop.textContent = pending && operation.activeKind === 'stopping' ? 'SCHEDULING…' : 'STOP NEXT BAR'

  if (!region) {
    controls.status.textContent = 'EMPTY'
    return
  }
  if (!region.fields.region.fields.isEnabled.value) {
    controls.status.textContent = 'READY'
    return
  }
  const regions = nexus
    ? contiguousAudioRegions(nexus.queryEntities, region)
    : [region]
  const positionTicks = regions[0]?.fields.region.fields.positionTicks.value
    ?? region.fields.region.fields.positionTicks.value
  const durationTicks = audioRegionChainDuration(regions)
  const fullDurationTicks = getSynchronizedDeckFullDurationTicks(deckIndex)
  const naturalDurationTicks = fullDurationTicks === null
    ? null
    : planRegionLaunch(
        fullDurationTicks,
        0,
        deckIndex < 2 ? decks[deckIndex].scheduledCuePosition : 0,
      ).durationTicks
  if (naturalDurationTicks !== null && durationTicks < naturalDurationTicks) {
    controls.status.textContent = `STOP · BAR ${tickToBar(positionTicks + durationTicks, Ticks.Bars(1))}`
    return
  }
  controls.status.textContent = `SCHEDULED · BAR ${tickToBar(positionTicks, Ticks.Bars(1))}`
}

function clearDeckTransportError(deckIndex: WaveformDeckIndex) {
  getDeckTransportElements(deckIndex).error.textContent = ''
}

function setDeckTransportError(deckIndex: WaveformDeckIndex, message: string) {
  getDeckTransportElements(deckIndex).error.textContent = message.toUpperCase()
}

function assertDeckMutationContext(
  projectDocument: SyncedDocument,
  deckIndex: WaveformDeckIndex,
  expectedSession: number,
  regionId: string,
  trackId: string,
  audioDeviceId: string,
) {
  const deck = decks[deckIndex]
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
    || deck.regionEntity?.id !== regionId
    || deck.trackEntity?.id !== trackId
    || deck.audioDeviceEntity?.id !== audioDeviceId
  ) {
    throw new Error('The project session, region, or routing graph changed')
  }
}

async function automaticGuardedTransportTicks(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  const projectId = currentProjectId
  const bpm = currentProjectBpm
  if (!projectId || !isSupportedBpm(bpm)) return null
  const position = await requestExtensionTransportPosition(projectId, deckIndex)
  if (
    nexus !== projectDocument
    || expectedSession !== tempoSessionId
    || currentProjectBpm !== bpm
  ) {
    throw new Error('Project connection or tempo changed during transport capture')
  }
  return position
    ? guardedTransportTicks(
        position,
        bpm,
        Date.now(),
        Ticks.Beat,
        Ticks.Bars(1),
      )
    : null
}

async function resolveDeckLaunchTarget(
  deckIndex: WaveformDeckIndex,
  action: LaunchPositionAction,
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  if (action === 'reenter-bar') {
    const targetBar = await showBarAssistant(
      deckIndex,
      'reenter-launch',
    )
    if (targetBar === null) return null
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
    ) {
      throw new Error('Project connection changed during launch position entry')
    }
    return barToPositionTicks(targetBar, Ticks.Bars(1))
  }

  const controlledRegionId = decks[deckIndex].regionEntity?.id
  const controlledRegion = controlledRegionId
    ? projectDocument.queryEntities.ofTypes('audioRegion').getEntity(controlledRegionId)
    : null
  const recoveredRegions = controlledRegion
    ? contiguousAudioRegions(projectDocument.queryEntities, controlledRegion)
    : []
  const recoveredPositionTicks = recoveredRegions[0]?.fields.region.fields.positionTicks.value
    ?? controlledRegion?.fields.region.fields.positionTicks.value
    ?? null
  if (recoveredPositionTicks === null) throw new Error('The deck region position is unavailable')

  return moveLaunchPosition(
    recoveredPositionTicks,
    action,
    Ticks.Beat,
    Ticks.Bars(1),
  )
}

async function resolveDeckStopTarget(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  const guardedTicks = await automaticGuardedTransportTicks(
    deckIndex,
    projectDocument,
    expectedSession,
  )
  if (guardedTicks !== null) {
    return {
      guardedTicks,
      targetTicks: resolveLaunchTick('next-bar', guardedTicks, Ticks.Bars(1))!,
    }
  }
  const targetBar = await showBarAssistant(deckIndex, 'stop')
  if (targetBar === null) return null
  const targetTicks = barToPositionTicks(targetBar, Ticks.Bars(1))
  return { guardedTicks: Math.max(0, targetTicks - 1), targetTicks }
}

async function resolveDeckCancelPosition(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  const guardedTicks = await automaticGuardedTransportTicks(
    deckIndex,
    projectDocument,
    expectedSession,
  )
  if (guardedTicks !== null) return guardedTicks
  const currentBar = await showBarAssistant(deckIndex, 'cancel-check')
  if (currentBar === null) return null
  return guardedTransportTicks(
    { bar: currentBar, precision: 'bar', capturedAt: Date.now() },
    currentProjectBpm ?? 120,
    Date.now(),
    Ticks.Beat,
    Ticks.Bars(1),
  )
}

function crossfadeAutomationName(deckIndex: WaveformDeckIndex) {
  return `MAGIC DECK CROSSFADE ${deckIndex === 0 ? 'A' : deckIndex === 1 ? 'B' : 'MAGIC'}`
}

function deckVolumeAutomationName(deckIndex: WaveformDeckIndex) {
  return `MAGIC DECK VOLUME ${deckIndex === 0 ? 'A' : deckIndex === 1 ? 'B' : 'MAGIC'}`
}

function inspectDeckVolumeAutomation(
  entities: EntityQuery,
  deckIndex: WaveformDeckIndex,
  mixerChannel: NexusEntity<'mixerChannel'>,
) {
  const expectedName = deckVolumeAutomationName(deckIndex)
  const target = mixerChannel.fields.faderParameters.fields.postGain.location
  const targetTracks = entities
    .ofTypes('automationTrack')
    .get()
    .filter((track) => track.fields.automatedParameter.value.equals(target))
  const ownedTracks = targetTracks.filter((track) => {
    const regions = entities
      .ofTypes('automationRegion')
      .get()
      .filter((region) => region.fields.track.value.entityId === track.id)
    return regions.length > 0 && regions.every((region) =>
      region.fields.region.fields.displayName.value === expectedName,
    )
  })
  return {
    conflict: targetTracks.length > 1
      || (targetTracks.length === 1 && ownedTracks.length !== 1),
    ownedTrack: ownedTracks.length === 1 ? ownedTracks[0] : null,
  }
}

function getOwnedDeckVolumeAutomationValue(
  entities: EntityQuery,
  deckIndex: WaveformDeckIndex,
  mixerChannel: NexusEntity<'mixerChannel'>,
) {
  const inspection = inspectDeckVolumeAutomation(entities, deckIndex, mixerChannel)
  if (inspection.conflict || !inspection.ownedTrack) return null
  const expectedName = deckVolumeAutomationName(deckIndex)
  const regions = entities
    .ofTypes('automationRegion')
    .get()
    .filter((region) =>
      region.fields.track.value.entityId === inspection.ownedTrack!.id
      && region.fields.region.fields.displayName.value === expectedName
      && region.fields.region.fields.positionTicks.value === 0,
    )
  if (regions.length !== 1) return null
  const collectionId = regions[0].fields.collection.value.entityId
  const startEvents = entities
    .ofTypes('automationEvent')
    .get()
    .filter((event) =>
      event.fields.collection.value.entityId === collectionId
      && event.fields.positionTicks.value === 0,
    )
  return startEvents.length === 1 ? startEvents[0].fields.value.value : null
}

function replaceDeckVolumeAutomation(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
  mixerChannel: NexusEntity<'mixerChannel'>,
  region: NexusEntity<'audioRegion'>,
  value: number,
) {
  const inspection = inspectDeckVolumeAutomation(t.entities, deckIndex, mixerChannel)
  if (inspection.conflict) {
    throw new Error(
      `${placementDeckLabel(deckIndex)} volume already has user automation; volume recording is unavailable`,
    )
  }
  const displayName = deckVolumeAutomationName(deckIndex)
  const target = mixerChannel.fields.faderParameters.fields.postGain
  const track = inspection.ownedTrack ?? t.create('automationTrack', {
    orderAmongTracks: nextTrackOrder(t.entities),
    automatedParameter: target.location,
  })
  const ownedRegions = t.entities
    .ofTypes('automationRegion')
    .get()
    .filter((candidate) =>
      candidate.fields.track.value.entityId === track.id
      && candidate.fields.region.fields.displayName.value === displayName,
    )
  const regionEndTicks =
    region.fields.region.fields.positionTicks.value
    + region.fields.region.fields.durationTicks.value
  if (!Number.isSafeInteger(regionEndTicks)) {
    throw new Error('Deck volume automation exceeds the safe tick range')
  }
  const durationTicks = Math.max(Ticks.Bars(1), regionEndTicks)
  if (ownedRegions.length === 1) {
    const ownedRegion = ownedRegions[0]
    const collectionId = ownedRegion.fields.collection.value.entityId
    const events = t.entities
      .ofTypes('automationEvent')
      .get()
      .filter((event) => event.fields.collection.value.entityId === collectionId)
    const startEvents = events.filter((event) => event.fields.positionTicks.value === 0)
    const terminalEvents = events.filter((event) => event.fields.positionTicks.value > 0)
    if (startEvents.length === 1 && terminalEvents.length === 1) {
      t.update(ownedRegion.fields.region.fields.positionTicks, 0)
      t.update(ownedRegion.fields.region.fields.durationTicks, durationTicks)
      t.update(ownedRegion.fields.region.fields.loopDurationTicks, durationTicks)
      t.update(ownedRegion.fields.region.fields.isEnabled, true)
      t.update(startEvents[0].fields.value, value)
      t.update(startEvents[0].fields.interpolation, 1)
      t.update(terminalEvents[0].fields.positionTicks, durationTicks)
      t.update(terminalEvents[0].fields.value, value)
      t.update(terminalEvents[0].fields.interpolation, 1)
      t.update(target, value)
      return
    }
  }
  ownedRegions.forEach((ownedRegion) => {
    const collectionId = ownedRegion.fields.collection.value.entityId
    const collection = t.entities.ofTypes('automationCollection').getEntity(collectionId)
    const events = t.entities
      .ofTypes('automationEvent')
      .get()
      .filter((event) => event.fields.collection.value.entityId === collectionId)
    t.remove(ownedRegion)
    events.forEach((event) => t.remove(event))
    if (collection) t.remove(collection)
  })

  const collection = t.create('automationCollection', {})
  t.create('automationEvent', {
    collection: collection.location,
    positionTicks: 0,
    value,
    interpolation: 1,
  })
  t.create('automationEvent', {
    collection: collection.location,
    positionTicks: durationTicks,
    value,
    interpolation: 1,
  })
  t.create('automationRegion', {
    collection: collection.location,
    track: track.location,
    region: {
      positionTicks: 0,
      durationTicks,
      loopDurationTicks: durationTicks,
      displayName,
      isEnabled: true,
    },
  })
  t.update(target, value)
}

function inspectGainAutomation(
  entities: EntityQuery,
  deckIndex: WaveformDeckIndex,
  audioDevice: NexusEntity<'audioDevice'>,
) {
  const expectedName = crossfadeAutomationName(deckIndex)
  const targetTracks = entities
    .ofTypes('automationTrack')
    .get()
    .filter((track) =>
      track.fields.automatedParameter.value.equals(audioDevice.fields.gain.location),
    )
  const ownedTracks = targetTracks.filter((track) => {
    const regions = entities
      .ofTypes('automationRegion')
      .get()
      .filter((region) => region.fields.track.value.entityId === track.id)
    return regions.length > 0 && regions.every((region) =>
      region.fields.region.fields.displayName.value === expectedName,
    )
  })
  return {
    conflict: targetTracks.length > 1
      || (targetTracks.length === 1 && ownedTracks.length !== 1),
    ownedTrack: ownedTracks.length === 1 ? ownedTracks[0] : null,
  }
}

function deckHasUserGainAutomation(deckIndex: WaveformDeckIndex) {
  const projectDocument = nexus
  const audioDevice = decks[deckIndex].audioDeviceEntity
  return projectDocument && audioDevice
    ? inspectGainAutomation(projectDocument.queryEntities, deckIndex, audioDevice).conflict
    : false
}

function findOwnedGainAutomationTrack(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
  audioDevice: NexusEntity<'audioDevice'>,
) {
  const inspection = inspectGainAutomation(t.entities, deckIndex, audioDevice)
  if (inspection.conflict) {
    throw new Error(
      `${placementDeckLabel(deckIndex)} gain already has user automation; crossfade is unavailable`,
    )
  }
  return inspection.ownedTrack
}

function replaceCrossfadeAutomation(
  t: SafeTransactionBuilder,
  deckIndex: WaveformDeckIndex,
  audioDevice: NexusEntity<'audioDevice'>,
  positionTicks: number,
  durationTicks: number,
  startValue: number,
  endValue: number,
) {
  const displayName = crossfadeAutomationName(deckIndex)
  const existingTrack = findOwnedGainAutomationTrack(t, deckIndex, audioDevice)
  const track = existingTrack ?? t.create('automationTrack', {
    orderAmongTracks: nextTrackOrder(t.entities),
    automatedParameter: audioDevice.fields.gain.location,
  })
  const ownedRegions = t.entities
    .ofTypes('automationRegion')
    .get()
    .filter((region) =>
      region.fields.track.value.entityId === track.id
      && region.fields.region.fields.displayName.value === displayName,
    )
  ownedRegions.forEach((region) => {
    const collectionId = region.fields.collection.value.entityId
    const collection = t.entities.ofTypes('automationCollection').getEntity(collectionId)
    const events = t.entities
      .ofTypes('automationEvent')
      .get()
      .filter((event) => event.fields.collection.value.entityId === collectionId)
    t.remove(region)
    events.forEach((event) => t.remove(event))
    if (collection) t.remove(collection)
  })

  const collection = t.create('automationCollection', {})
  t.create('automationEvent', {
    collection: collection.location,
    positionTicks: 0,
    value: startValue,
    interpolation: 2,
  })
  t.create('automationEvent', {
    collection: collection.location,
    positionTicks: durationTicks,
    value: endValue,
    interpolation: 2,
  })
  t.create('automationRegion', {
    collection: collection.location,
    track: track.location,
    region: {
      positionTicks,
      durationTicks,
      loopDurationTicks: durationTicks,
      displayName,
      isEnabled: true,
    },
  })
}

async function mutateDeckCrossfade(
  incomingDeckIndex: WaveformDeckIndex,
  outgoingDeckIndex: WaveformDeckIndex,
  action: LaunchPositionAction,
  fadeBars: number,
  expectedSession: number,
) {
  if (incomingDeckIndex === outgoingDeckIndex) throw new Error('Choose a different outgoing deck')
  if (![1, 2, 4, 8].includes(fadeBars)) throw new Error('Crossfade duration must be 1, 2, 4, or 8 bars')
  const projectDocument = nexus
  const incomingDeck = decks[incomingDeckIndex]
  const outgoingDeck = decks[outgoingDeckIndex]
  const incomingRegionId = incomingDeck.regionEntity?.id
  const outgoingRegionId = outgoingDeck.regionEntity?.id
  const incomingTrackId = incomingDeck.trackEntity?.id
  const outgoingTrackId = outgoingDeck.trackEntity?.id
  const incomingDeviceId = incomingDeck.audioDeviceEntity?.id
  const outgoingDeviceId = outgoingDeck.audioDeviceEntity?.id
  if (
    !projectDocument
    || !incomingRegionId
    || !outgoingRegionId
    || !incomingTrackId
    || !outgoingTrackId
    || !incomingDeviceId
    || !outgoingDeviceId
  ) {
    throw new Error('Both crossfade decks need synchronized regions and routing')
  }
  const targetTicks = await resolveDeckLaunchTarget(
    incomingDeckIndex,
    action,
    projectDocument,
    expectedSession,
  )
  if (targetTicks === null) return false
  const fadeDurationTicks = Ticks.Bars(fadeBars)
  await serializeSourceTiming(() => projectDocument.modify((t) => {
    assertDeckMutationContext(
      projectDocument,
      incomingDeckIndex,
      expectedSession,
      incomingRegionId,
      incomingTrackId,
      incomingDeviceId,
    )
    assertDeckMutationContext(
      projectDocument,
      outgoingDeckIndex,
      expectedSession,
      outgoingRegionId,
      outgoingTrackId,
      outgoingDeviceId,
    )
    const incomingRegion = t.entities.ofTypes('audioRegion').getEntity(incomingRegionId)
    const outgoingRegion = t.entities.ofTypes('audioRegion').getEntity(outgoingRegionId)
    const incomingDevice = t.entities.ofTypes('audioDevice').getEntity(incomingDeviceId)
    const outgoingDevice = t.entities.ofTypes('audioDevice').getEntity(outgoingDeviceId)
    if (!incomingRegion || !outgoingRegion || !incomingDevice || !outgoingDevice) {
      throw new Error('A crossfade deck changed before scheduling')
    }
    if (!outgoingRegion.fields.region.fields.isEnabled.value) {
      throw new Error('The outgoing deck is not enabled on the project timeline')
    }
    const incomingFullDurationTicks = getDeckFullDurationTicks(
      t,
      incomingDeckIndex,
      incomingRegion,
    )
    const incomingPlan = planRegionLaunch(
      incomingFullDurationTicks,
      targetTicks,
      0,
    )
    if (incomingDeckIndex < 2) {
      applySourceDeckLaunchPlan(
        t,
        incomingRegion,
        incomingPlan,
        incomingFullDurationTicks,
      )
    } else {
      const incomingRegions = updateDeckRegionChainTiming(
        t,
        incomingRegion,
        incomingPlan.positionTicks,
        incomingPlan.durationTicks,
      )
      updateAudioRegionChainEnabled(t, incomingRegions, incomingPlan.isEnabled)
    }

    const fadeEndTicks = targetTicks + fadeDurationTicks
    if (!Number.isSafeInteger(fadeEndTicks)) throw new Error('Crossfade boundary exceeds the safe tick range')
    const outgoingRegions = contiguousAudioRegions(t.entities, outgoingRegion)
    const outgoingPositionTicks =
      outgoingRegions[0]?.fields.region.fields.positionTicks.value
      ?? outgoingRegion.fields.region.fields.positionTicks.value
    const outgoingFullDurationTicks = getDeckFullDurationTicks(
      t,
      outgoingDeckIndex,
      outgoingRegion,
    )
    const outgoingNaturalDurationTicks = planRegionLaunch(
      outgoingFullDurationTicks,
      0,
      outgoingDeckIndex < 2 ? outgoingDeck.scheduledCuePosition : 0,
    ).durationTicks
    const outgoingPlan = planRegionStop(
      outgoingPositionTicks,
      audioRegionChainDuration(outgoingRegions),
      outgoingNaturalDurationTicks,
      true,
      targetTicks,
      fadeEndTicks,
    )
    if (outgoingPlan.kind === 'cancel') {
      throw new Error('The outgoing deck has not begun by the crossfade boundary')
    }
    if (outgoingPlan.kind === 'stop') {
      updateDeckRegionChainTiming(
        t,
        outgoingRegion,
        outgoingPositionTicks,
        outgoingPlan.durationTicks,
      )
    }
    replaceCrossfadeAutomation(
      t,
      incomingDeckIndex,
      incomingDevice,
      targetTicks,
      fadeDurationTicks,
      0,
      incomingDevice.fields.gain.value,
    )
    replaceCrossfadeAutomation(
      t,
      outgoingDeckIndex,
      outgoingDevice,
      targetTicks,
      fadeDurationTicks,
      outgoingDevice.fields.gain.value,
      0,
    )
  }))
  if (nexus !== projectDocument || expectedSession !== tempoSessionId) {
    throw new Error('Project connection changed after crossfade scheduling')
  }
  if (incomingDeckIndex < 2) incomingDeck.scheduledCuePosition = 0
  return true
}

async function mutateDeckLaunch(
  deckIndex: WaveformDeckIndex,
  action: LaunchPositionAction,
  expectedSession: number,
) {
  const projectDocument = nexus
  const deck = decks[deckIndex]
  const regionId = deck.regionEntity?.id
  const trackId = deck.trackEntity?.id
  const audioDeviceId = deck.audioDeviceEntity?.id
  if (!projectDocument || !regionId || !trackId || !audioDeviceId) {
    throw new Error('The synchronized deck region and routing graph are required')
  }
  const targetTicks = await resolveDeckLaunchTarget(
    deckIndex,
    action,
    projectDocument,
    expectedSession,
  )
  if (targetTicks === null) return false
  assertDeckMutationContext(
    projectDocument,
    deckIndex,
    expectedSession,
    regionId,
    trackId,
    audioDeviceId,
  )
  await serializeSourceTiming(() => projectDocument.modify((t) => {
    assertDeckMutationContext(
      projectDocument,
      deckIndex,
      expectedSession,
      regionId,
      trackId,
      audioDeviceId,
    )
    const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
    const track = t.entities.ofTypes('audioTrack').getEntity(trackId)
    const audioDevice = t.entities.ofTypes('audioDevice').getEntity(audioDeviceId)
    if (!region || !track || !audioDevice || region.fields.track.value.entityId !== trackId) {
      throw new Error('The deck region or routing graph changed before launch')
    }
    const fullDurationTicks = getDeckFullDurationTicks(t, deckIndex, region)
    const plan = planRegionLaunch(
      fullDurationTicks,
      targetTicks,
      0,
    )
    if (deckIndex < 2) {
      applySourceDeckLaunchPlan(t, region, plan, fullDurationTicks)
    } else {
      const regions = updateDeckRegionChainTiming(
        t,
        region,
        plan.positionTicks,
        plan.durationTicks,
      )
      updateAudioRegionChainEnabled(t, regions, plan.isEnabled)
    }
  }))
  if (nexus !== projectDocument || expectedSession !== tempoSessionId) {
    throw new Error('Project connection changed after launch scheduling')
  }
  if (deckIndex < 2) deck.scheduledCuePosition = 0
  return true
}

async function mutateDeckCancel(deckIndex: WaveformDeckIndex, expectedSession: number) {
  const projectDocument = nexus
  const deck = decks[deckIndex]
  const regionId = deck.regionEntity?.id
  const trackId = deck.trackEntity?.id
  const audioDeviceId = deck.audioDeviceEntity?.id
  if (!projectDocument || !regionId || !trackId || !audioDeviceId) {
    throw new Error('The synchronized deck region and routing graph are required')
  }
  const guardedTicks = await resolveDeckCancelPosition(deckIndex, projectDocument, expectedSession)
  if (guardedTicks === null) return false
  await serializeSourceTiming(() => projectDocument.modify((t) => {
    assertDeckMutationContext(
      projectDocument,
      deckIndex,
      expectedSession,
      regionId,
      trackId,
      audioDeviceId,
    )
    const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
    if (!region || region.fields.track.value.entityId !== trackId) {
      throw new Error('The deck region changed before cancellation')
    }
    const regions = contiguousAudioRegions(t.entities, region)
    const positionTicks = regions[0]?.fields.region.fields.positionTicks.value
      ?? region.fields.region.fields.positionTicks.value
    const plan = planRegionCancel(positionTicks, guardedTicks)
    if (plan.kind === 'refuse') {
      throw new Error('Launch boundary reached — use Stop Next Bar')
    }
    updateAudioRegionChainEnabled(t, regions, plan.isEnabled)
  }))
  return true
}

async function mutateDeckStop(deckIndex: WaveformDeckIndex, expectedSession: number) {
  const projectDocument = nexus
  const deck = decks[deckIndex]
  const regionId = deck.regionEntity?.id
  const trackId = deck.trackEntity?.id
  const audioDeviceId = deck.audioDeviceEntity?.id
  if (!projectDocument || !regionId || !trackId || !audioDeviceId) {
    throw new Error('The synchronized deck region and routing graph are required')
  }
  const transport = await resolveDeckStopTarget(deckIndex, projectDocument, expectedSession)
  if (transport === null) return false
  await serializeSourceTiming(() => projectDocument.modify((t) => {
    assertDeckMutationContext(
      projectDocument,
      deckIndex,
      expectedSession,
      regionId,
      trackId,
      audioDeviceId,
    )
    const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
    if (!region || region.fields.track.value.entityId !== trackId) {
      throw new Error('The deck region changed before stop scheduling')
    }
    const regions = contiguousAudioRegions(t.entities, region)
    const positionTicks = regions[0]?.fields.region.fields.positionTicks.value
      ?? region.fields.region.fields.positionTicks.value
    const fullDurationTicks = getDeckFullDurationTicks(t, deckIndex, region)
    const naturalDurationTicks = planRegionLaunch(
      fullDurationTicks,
      0,
      deckIndex < 2 ? deck.scheduledCuePosition : 0,
    ).durationTicks
    const plan = planRegionStop(
      positionTicks,
      audioRegionChainDuration(regions),
      naturalDurationTicks,
      region.fields.region.fields.isEnabled.value,
      transport.guardedTicks,
      transport.targetTicks,
    )
    if (plan.kind === 'cancel') {
      updateAudioRegionChainEnabled(t, regions, plan.isEnabled)
    } else if (plan.kind === 'stop') {
      updateDeckRegionChainTiming(t, region, positionTicks, plan.durationTicks)
    }
  }))
  return true
}

function queueDeckTransportOperation(
  deckIndex: WaveformDeckIndex,
  kind: 'launching' | 'cue-scheduling' | 'cancelling' | 'stopping',
  task: (expectedSession: number) => Promise<boolean>,
  relatedDeckIndex?: WaveformDeckIndex,
) {
  const operation = deckOperationStates[deckIndex]
  const relatedOperation = relatedDeckIndex === undefined
    ? null
    : deckOperationStates[relatedDeckIndex]
  if (
    operation.pendingCount > 0
    || relatedOperation?.pendingCount
    || !projectConnected
    || !decks[deckIndex].regionEntity
    || (relatedDeckIndex !== undefined && !decks[relatedDeckIndex].regionEntity)
  ) return
  const expectedSession = tempoSessionId
  operation.pendingCount += 1
  operation.activeKind = kind
  if (relatedOperation) {
    relatedOperation.pendingCount += 1
    relatedOperation.activeKind = 'stopping'
    renderDeckTransport(relatedDeckIndex!)
    renderCueControls(relatedDeckIndex!)
  }
  clearDeckTransportError(deckIndex)
  renderDeckTransport(deckIndex)
  renderCueControls(deckIndex)
  deckLoadQueue = deckLoadQueue
    .then(async () => {
      if (expectedSession !== tempoSessionId) return
      const changed = await task(expectedSession)
      if (changed) setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: PROJECT TIMELINE UPDATED ✓`)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setDeckTransportError(deckIndex, message)
      setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: ${message}`)
    })
    .finally(() => {
      operation.pendingCount = Math.max(0, operation.pendingCount - 1)
      if (operation.pendingCount === 0) operation.activeKind = null
      if (relatedOperation) {
        relatedOperation.pendingCount = Math.max(0, relatedOperation.pendingCount - 1)
        if (relatedOperation.pendingCount === 0) relatedOperation.activeKind = null
        renderDeckTransport(relatedDeckIndex!)
        renderCueControls(relatedDeckIndex!)
      }
      renderDeckTransport(deckIndex)
      renderCueControls(deckIndex)
    })
}

async function syncMagicLoopDuration(projectDocument: SyncedDocument, expectedSession: number) {
  if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
  await projectDocument.modify((t) => {
    updateMagicLoopDurationInTransaction(t)
  })
}

function handleExternalSourceContentRemoval(
  deckIndex: 0 | 1,
  projectDocument: SyncedDocument,
  expectedSession: number,
) {
  if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
  if (deckOperationStates[deckIndex].suppressProjectRemovalSync) return
  const remaining = sourceDeckInstances(projectDocument.queryEntities, deckIndex)
    .sort((left, right) =>
      right.fields.region.fields.positionTicks.value
        - left.fields.region.fields.positionTicks.value
      || right.id.localeCompare(left.id))[0]
  if (remaining) {
    const sample = projectDocument.queryEntities
      .ofTypes('sample')
      .getEntity(remaining.fields.sample.value.entityId)
    const automationCollection = projectDocument.queryEntities
      .ofTypes('automationCollection')
      .getEntity(remaining.fields.playbackAutomationCollection.value.entityId)
    if (sample && automationCollection) {
      bindDeckContentGraph(deckIndex, projectDocument, {
        region: remaining,
        sample,
        automationCollection,
      }, expectedSession)
      const terminal = getExpectedPlaybackTerminalEvent(
        { entities: projectDocument.queryEntities },
        remaining,
      )
      const fullDurationTicks = terminal?.fields.positionTicks.value
      const collectionOffsetTicks = remaining.fields.region.fields.collectionOffsetTicks.value
      decks[deckIndex].scheduledCuePosition = fullDurationTicks
        ? collectionOffsetTicks / fullDurationTicks
        : 0
      renderCueControls(deckIndex)
      updateSourceDeckUi(deckIndex)
      setStatus('connected', `DECK ${deckIndex + 1}: CONTROL TRANSFERRED TO LATEST REMAINING INSTANCE`)
      return
    }
  }
  const reportWasActive = manualBpmReportStates[deckIndex].editing
  clearSourceDeckLocalMedia(deckIndex)
  clearDeckContentEntities(decks[deckIndex])
  updateSourceDeckUi(deckIndex)
  void syncMagicLoopDuration(projectDocument, expectedSession)
  setStatus(
    reportWasActive ? 'error' : 'connected',
    reportWasActive
      ? `DECK ${deckIndex + 1}: BPM REPORT CANCELLED — PROJECT REGION WAS REMOVED`
      : `DECK ${deckIndex + 1}: PROJECT REGION REMOVED — TRACK IS EMPTY`,
  )
}

function handleExternalSourceRoutingRemoval(
  deckIndex: 0 | 1,
  projectDocument: SyncedDocument,
  expectedSession: number,
  removedEntity: 'track' | 'device',
) {
  if (deckOperationStates[deckIndex].suppressProjectRemovalSync) return
  const reportWasActive = manualBpmReportStates[deckIndex].editing
  clearSourceDeckLocalMedia(deckIndex)
  clearDeckProjectEntities(decks[deckIndex])
  updateSourceDeckUi(deckIndex)
  void syncMagicLoopDuration(projectDocument, expectedSession)
  setStatus(
    reportWasActive ? 'error' : 'connected',
    reportWasActive
      ? `DECK ${deckIndex + 1}: BPM REPORT CANCELLED — PROJECT ${removedEntity.toUpperCase()} WAS REMOVED`
      : `DECK ${deckIndex + 1}: PROJECT ${removedEntity.toUpperCase()} REMOVED — ROUTING CLEARED`,
  )
}

function handleExternalMagicContentRemoval() {
  if (suppressMagicProjectRemovalSync) return
  clearMagicDeckLocalMedia()
  clearDeckContentEntities(decks[2])
  setMagicStatus('warning', 'PROJECT REGION REMOVED · MAGIC TRACK IS EMPTY')
}

function handleExternalMagicRoutingRemoval(removedEntity: 'track' | 'device') {
  if (suppressMagicProjectRemovalSync) return
  clearMagicDeckLocalMedia()
  clearDeckProjectEntities(decks[2])
  setMagicStatus('warning', `PROJECT ${removedEntity.toUpperCase()} REMOVED · GENERATE TO REPLACE`)
}

function watchDeckRouting(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  routing: ResolvedDeckRoutingGraph,
  expectedSession: number,
) {
  const deck = decks[deckIndex]
  const hydrateFiltersIfCurrent = () => {
    if (
      nexus !== projectDocument
      || expectedSession !== tempoSessionId
      || deck.mixerChannelEntity?.id !== routing.mixerChannel.id
    ) return
    hydrateDeckFilterControls(deckIndex, routing.mixerChannel)
  }
  deck.routingSubscriptions.push(
    projectDocument.events.onUpdate(
      routing.mixerChannel.fields.faderParameters.fields.postGain,
      (volume) => {
        if (
          nexus !== projectDocument
          || expectedSession !== tempoSessionId
          || deck.mixerChannelEntity?.id !== routing.mixerChannel.id
        ) return
        deck.volume = Math.max(0, Math.min(1, volume))
        el<HTMLInputElement>(`d${deckIndex + 1}-vol`).value = String(deck.volume)
        el(`d${deckIndex + 1}-vol-val`).textContent = String(Math.round(deck.volume * 100))
      },
    ),
    projectDocument.events.onUpdate(
      routing.mixerChannel.fields.trimFilter.fields.highPassCutoffFrequencyHz,
      hydrateFiltersIfCurrent,
    ),
    projectDocument.events.onUpdate(
      routing.mixerChannel.fields.trimFilter.fields.lowPassCutoffFrequencyHz,
      hydrateFiltersIfCurrent,
    ),
    projectDocument.events.onUpdate(
      routing.mixerChannel.fields.trimFilter.fields.isActive,
      hydrateFiltersIfCurrent,
    ),
    projectDocument.events.onRemove(routing.track, () => {
      if (
        nexus !== projectDocument
        || expectedSession !== tempoSessionId
        || deck.trackEntity?.id !== routing.track.id
      ) return
      if (deckIndex < 2) {
        handleExternalSourceRoutingRemoval(
          deckIndex as 0 | 1,
          projectDocument,
          expectedSession,
          'track',
        )
      } else {
        handleExternalMagicRoutingRemoval('track')
      }
    }),
    projectDocument.events.onRemove(routing.audioDevice, () => {
      if (
        nexus !== projectDocument
        || expectedSession !== tempoSessionId
        || deck.audioDeviceEntity?.id !== routing.audioDevice.id
      ) return
      if (deckIndex < 2) {
        handleExternalSourceRoutingRemoval(
          deckIndex as 0 | 1,
          projectDocument,
          expectedSession,
          'device',
        )
      } else {
        handleExternalMagicRoutingRemoval('device')
      }
    }),
  )
  if (routing.fxGraph) {
    const { delay, reverb, distortion, flanger } = routing.fxGraph
    const graphIsCurrent = () => {
      const currentGraph = decks[deckIndex].fxGraph
      return currentGraph?.delay.id === delay.id
        && currentGraph.reverb.id === reverb.id
        && currentGraph.distortion.id === distortion.id
        && currentGraph.flanger.id === flanger.id
    }
    const hydrateIfCurrent = () => {
      if (
        nexus !== projectDocument
        || expectedSession !== tempoSessionId
        || activeFxDeckIndex !== deckIndex
        || !graphIsCurrent()
      ) return
      hydrateDeckFxControls(deckIndex, routing.fxGraph!)
    }
    const handleFxRoutingRemoval = () => {
      if (
        nexus !== projectDocument
        || expectedSession !== tempoSessionId
        || !graphIsCurrent()
      ) return
      clearDeckRoutingEntities(deck)
      renderDeckFxAvailability()
      setStatus(
        'error',
        `${placementDeckLabel(deckIndex).toUpperCase()}: SYNCHRONIZED FX ROUTING IS UNAVAILABLE`,
      )
    }
    deck.routingSubscriptions.push(
      projectDocument.events.onUpdate(delay.fields.mix, hydrateIfCurrent),
      projectDocument.events.onUpdate(delay.fields.isActive, hydrateIfCurrent),
      projectDocument.events.onUpdate(reverb.fields.mix, hydrateIfCurrent),
      projectDocument.events.onUpdate(reverb.fields.isActive, hydrateIfCurrent),
      projectDocument.events.onUpdate(distortion.fields.drive, hydrateIfCurrent),
      projectDocument.events.onUpdate(distortion.fields.isActive, hydrateIfCurrent),
      projectDocument.events.onUpdate(flanger.fields.lfoModulationDepth, hydrateIfCurrent),
      projectDocument.events.onUpdate(flanger.fields.isActive, hydrateIfCurrent),
      projectDocument.events.onRemove(delay, handleFxRoutingRemoval),
      projectDocument.events.onRemove(reverb, handleFxRoutingRemoval),
      projectDocument.events.onRemove(distortion, handleFxRoutingRemoval),
      projectDocument.events.onRemove(flanger, handleFxRoutingRemoval),
      ...routing.fxGraph.cables.map((cable) =>
        projectDocument.events.onRemove(cable, handleFxRoutingRemoval)),
    )
  }
}

function watchSourceDeckContent(
  deckIndex: 0 | 1,
  projectDocument: SyncedDocument,
  region: NexusEntity<'audioRegion'>,
  expectedSession: number,
) {
  const deck = decks[deckIndex]
  const terminalEvent = getExpectedPlaybackTerminalEvent(
    { entities: projectDocument.queryEntities },
    region,
  )
  deck.contentSubscriptions.push(
    projectDocument.events.onUpdate(region.fields.region.fields.durationTicks, () => {
      if (deck.regionEntity?.id === region.id) {
        scheduleDeckTimingReconstruction(deckIndex)
        if (
          deckOperationStates[deckIndex].activeKind !== 'loading'
          && deckOperationStates[deckIndex].activeKind !== 'replacing'
        ) void syncMagicLoopDuration(projectDocument, expectedSession)
        renderDeckTransport(deckIndex)
      }
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.positionTicks, () => {
      if (deck.regionEntity?.id === region.id) renderDeckTransport(deckIndex)
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.isEnabled, () => {
      if (deck.regionEntity?.id === region.id) renderDeckTransport(deckIndex)
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.loopDurationTicks, () => {
      if (deck.regionEntity?.id === region.id) scheduleDeckTimingReconstruction(deckIndex)
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.collectionOffsetTicks, () => {
      if (
        deck.regionEntity?.id !== region.id
        || deckOperationStates[deckIndex].pendingCount > 0
        || deck.tempoUpdatePending
      ) return
      const terminal = getExpectedPlaybackTerminalEvent(
        { entities: projectDocument.queryEntities },
        region,
      )
      const fullDurationTicks = terminal?.fields.positionTicks.value
      const collectionOffsetTicks = region.fields.region.fields.collectionOffsetTicks.value
      deck.scheduledCuePosition = fullDurationTicks && collectionOffsetTicks > 0
        ? Math.min((fullDurationTicks - 1) / fullDurationTicks, collectionOffsetTicks / fullDurationTicks)
        : 0
      renderDeckTransport(deckIndex)
    }),
    projectDocument.events.onRemove(region, () => {
      if (deck.regionEntity?.id !== region.id) return
      if (guardedRegionRemovalIds.has(region.id)) return
      handleExternalSourceContentRemoval(deckIndex, projectDocument, expectedSession)
    }),
  )
  if (terminalEvent) {
    deck.contentSubscriptions.push(
      projectDocument.events.onUpdate(terminalEvent.fields.positionTicks, () => {
        if (deck.regionEntity?.id === region.id) scheduleDeckTimingReconstruction(deckIndex)
      }),
    )
  }
}

function watchMagicDeckContent(
  projectDocument: SyncedDocument,
  region: NexusEntity<'audioRegion'>,
  expectedSession: number,
) {
  const magicDeck = decks[2]
  const terminalEvent = getExpectedPlaybackTerminalEvent(
    { entities: projectDocument.queryEntities },
    region,
  )
  magicDeck.contentSubscriptions.push(
    projectDocument.events.onUpdate(region.fields.region.fields.durationTicks, () => {
      if (magicDeck.regionEntity?.id === region.id) renderDeckTransport(2)
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.positionTicks, () => {
      if (magicDeck.regionEntity?.id === region.id) renderDeckTransport(2)
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.isEnabled, () => {
      if (magicDeck.regionEntity?.id === region.id) renderDeckTransport(2)
    }),
    projectDocument.events.onUpdate(region.fields.region.fields.loopDurationTicks, () => {
      if (magicDeck.regionEntity?.id === region.id) scheduleDeckTimingReconstruction(2)
    }),
    projectDocument.events.onRemove(region, () => {
      if (
        nexus !== projectDocument
        || expectedSession !== tempoSessionId
        || magicDeck.regionEntity?.id !== region.id
        || guardedRegionRemovalIds.has(region.id)
      ) return
      handleExternalMagicContentRemoval()
    }),
  )
  if (terminalEvent) {
    magicDeck.contentSubscriptions.push(
      projectDocument.events.onUpdate(terminalEvent.fields.positionTicks, () => {
        if (magicDeck.regionEntity?.id === region.id) scheduleDeckTimingReconstruction(2)
      }),
    )
  }
}

function bindDeckRoutingGraph(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  routing: ResolvedDeckRoutingGraph,
  expectedSession: number,
) {
  const deck = decks[deckIndex]
  const alreadyBound =
    deck.trackEntity?.id === routing.track.id
    && deck.audioDeviceEntity?.id === routing.audioDevice.id
    && deck.mixerChannelEntity?.id === routing.mixerChannel.id
    && deck.cableEntity?.id === routing.cable.id
  if (alreadyBound) return

  clearDeckProjectEntities(deck)
  deck.trackEntity = routing.track
  deck.audioDeviceEntity = routing.audioDevice
  deck.mixerChannelEntity = routing.mixerChannel
  deck.cableEntity = routing.cable
  deck.fxGraph = routing.fxGraph
  hydrateRestoredProjectControls(deckIndex, projectDocument.queryEntities, routing.mixerChannel)
  watchDeckRouting(deckIndex, projectDocument, routing, expectedSession)
}

function bindDeckFxRoutingGraph(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  routing: ResolvedDeckRoutingGraph,
  expectedSession: number,
) {
  const deck = decks[deckIndex]
  clearDeckRoutingEntities(deck, true)
  deck.trackEntity = routing.track
  deck.audioDeviceEntity = routing.audioDevice
  deck.mixerChannelEntity = routing.mixerChannel
  deck.cableEntity = routing.cable
  deck.fxGraph = routing.fxGraph
  hydrateRestoredProjectControls(deckIndex, projectDocument.queryEntities, routing.mixerChannel)
  watchDeckRouting(deckIndex, projectDocument, routing, expectedSession)
}

function bindDeckContentGraph(
  deckIndex: WaveformDeckIndex,
  projectDocument: SyncedDocument,
  content: ResolvedDeckContentGraph,
  expectedSession: number,
) {
  const deck = decks[deckIndex]
  const replacingBoundContent = deck.regionEntity !== null
  deck.contentSubscriptions.forEach((subscription) => subscription.terminate())
  deck.contentSubscriptions = []
  deck.regionEntity = content.region
  deck.sampleEntity = content.sample
  deck.automationCollectionEntity = content.automationCollection
  if (deckIndex < 2) {
    if (!replacingBoundContent) {
      const terminalEvent = getExpectedPlaybackTerminalEvent(
        { entities: projectDocument.queryEntities },
        content.region,
      )
      const fullDurationTicks = terminalEvent?.fields.positionTicks.value
      const collectionOffsetTicks = content.region.fields.region.fields.collectionOffsetTicks.value
      deck.scheduledCuePosition = fullDurationTicks && collectionOffsetTicks > 0
        ? Math.min((fullDurationTicks - 1) / fullDurationTicks, collectionOffsetTicks / fullDurationTicks)
        : 0
    }
    watchSourceDeckContent(
      deckIndex as 0 | 1,
      projectDocument,
      content.region,
      expectedSession,
    )
  } else {
    watchMagicDeckContent(projectDocument, content.region, expectedSession)
  }
  scheduleDeckTimingReconstruction(deckIndex)
  renderDeckTransport(deckIndex)
}

async function insertSampleIntoProject(
  deckNum: number,
  sample: SampleMeta,
  displayName: string,
  forceMagicLoop: boolean,
  placement: DeckInsertionPlacement,
  resolution?: BpmResolution,
  expectedSession = tempoSessionId,
  timing?: SampleTiming,
) {
  if (!nexus) throw new Error('Project not connected')
  const projectDocument = nexus
  const deckIndex = (deckNum - 1) as WaveformDeckIndex
  const deck = decks[deckIndex]
  if (placement.deckIndex !== deckIndex) throw new Error('Insertion placement belongs to another deck')
  const expectedRoutingIds = {
    track: deck.trackEntity?.id,
    audioDevice: deck.audioDeviceEntity?.id,
    mixerChannel: deck.mixerChannelEntity?.id,
    cable: deck.cableEntity?.id,
  }
  if (Object.values(expectedRoutingIds).some((id) => id === undefined)) {
    throw new Error(`${DECK_PROJECT_NAMES[deckIndex]} canonical routing is not available`)
  }
  const sampleBpm = normalizeBpm(sample.bpm)
  const bpm = normalizeBpm(timing?.bpm ?? resolution?.bpm ?? (isSupportedBpm(sampleBpm) ? sampleBpm : currentProjectBpm))
  if (!isSupportedBpm(bpm)) throw new Error(`A BPM between ${MIN_SUPPORTED_BPM} and ${MAX_SUPPORTED_BPM} is required`)
  if (
    nexus !== projectDocument
    || !projectConnected
    || expectedSession !== tempoSessionId
  ) throw new Error('Project connection changed before insertion')

  const removedRegionIds: string[] = []
  const insertTransaction = async () => {
    try {
      return await projectDocument.modify((t) => {
        const canonical = reusableDeckGraphs(t.entities, deckIndex)[0]
        if (!canonical) {
          throw new Error(`${DECK_PROJECT_NAMES[deckIndex]} canonical track is no longer available`)
        }
        if (
          canonical.routing.track.id !== expectedRoutingIds.track
          || canonical.routing.audioDevice.id !== expectedRoutingIds.audioDevice
          || canonical.routing.mixerChannel.id !== expectedRoutingIds.mixerChannel
          || canonical.routing.cable.id !== expectedRoutingIds.cable
        ) {
          throw new Error(`${DECK_PROJECT_NAMES[deckIndex]} canonical routing changed before insertion`)
        }
        const targetTrack = t.entities
          .ofTypes('audioTrack')
          .getEntity(canonical.routing.track.id)
        if (!targetTrack) {
          throw new Error(`${DECK_PROJECT_NAMES[deckIndex]} canonical track is no longer available`)
        }
        const isSourceDeck = deckNum <= 2
        const replacementRegion = isSourceDeck && deck.regionEntity
          ? t.entities.ofTypes('audioRegion').getEntity(deck.regionEntity.id)
          : undefined
        const replacementRegionIds = replacementRegion
          ? sourceDeckInstanceRegions(t.entities, deckIndex as 0 | 1, replacementRegion)
            .map((candidate) => candidate.id)
          : []
        replacementRegionIds.forEach((regionId) => {
          guardedRegionRemovalIds.add(regionId)
          removedRegionIds.push(regionId)
        })
        if (replacementRegion) {
          removeDeckContentInTransaction(
            t,
            replacementRegion.id,
            deck.sampleEntity?.id,
            deck.automationCollectionEntity?.id,
            deckIndex as 0 | 1,
          )
        }
        const replacementRemovalIds = new Set(replacementRegionIds)
        const destinationRegions = t.entities
          .ofTypes('audioRegion')
          .get()
          .filter((region) =>
            region.fields.track.value.entityId === targetTrack.id
            && !replacementRemovalIds.has(region.id))
        const collisionPlan = planForwardTimelineInsertion(
          destinationRegions.map(regionSnapshot),
          placement.positionTicks,
        )
        if (collisionPlan.kind === 'reject') {
          throw new Error(collisionPlan.reason === 'region-starts-at-boundary'
            ? 'A deck region already starts at the selected bar; choose a later bar'
            : 'The selected bar is before this deck’s latest insertion; choose a later bar')
        }

        collisionPlan.truncate.forEach((truncation) => {
          const region = t.entities.ofTypes('audioRegion').getEntity(truncation.id)
          if (!region || region.fields.track.value.entityId !== targetTrack.id) {
            throw new Error('Destination deck content changed during collision planning')
          }
          t.update(region.fields.region.fields.durationTicks, truncation.durationTicks)
          if (region.fields.fadeInDurationTicks.value !== truncation.fadeInDurationTicks) {
            t.update(region.fields.fadeInDurationTicks, truncation.fadeInDurationTicks)
          }
          if (region.fields.fadeOutDurationTicks.value !== truncation.fadeOutDurationTicks) {
            t.update(region.fields.fadeOutDurationTicks, truncation.fadeOutDurationTicks)
          }
        })
        collisionPlan.removeRegionIds.forEach((regionId) => {
          const region = t.entities.ofTypes('audioRegion').getEntity(regionId)
          if (!region || region.fields.track.value.entityId !== targetTrack.id) {
            throw new Error('Destination deck content changed during collision planning')
          }
          guardedRegionRemovalIds.add(regionId)
          removedRegionIds.push(regionId)
          t.remove(region)
        })

        const config = t.entities.ofTypes('config').get()[0]
        const establishedTempo = isSourceDeck && !projectHasTimelineContent(t.entities)
        if (isSourceDeck && !config) throw new Error('Project tempo configuration was not found')
        const effectiveProjectBpm = establishedTempo
          ? bpm
          : Number(config?.fields.tempoBpm.value ?? currentProjectBpm)
        if (
          isSourceDeck
          && (
            !Number.isFinite(effectiveProjectBpm)
            || effectiveProjectBpm < MIN_SUPPORTED_BPM
            || effectiveProjectBpm > MAX_SUPPORTED_BPM
          )
        ) {
          throw new Error('Project tempo is outside the supported range')
        }
        if (establishedTempo && config) {
          t.update(config.fields.tempoBpm, bpm)
        }
        const sourceDurationTicks = isSourceDeck
          ? secondsToTicks(sample.durationSeconds, effectiveProjectBpm)
          : undefined
        const region = t.insertSample(sample, {
          sample: isSourceDeck
            ? { musicDurationTicks: sourceDurationTicks }
            : timing?.musicDurationTicks === undefined
              ? { bpm }
              : { musicDurationTicks: timing.musicDurationTicks },
          region: forceMagicLoop
            ? {
                positionTicks: placement.positionTicks,
                durationTicks: getMagicLoopDurationTicks(t),
              }
            : { positionTicks: placement.positionTicks },
          loop: forceMagicLoop ? true : undefined,
          attachTo: targetTrack,
          displayName,
        })
        if (isSourceDeck || forceMagicLoop) {
          t.update(region.fields.timestretchMode, 2)
        }
        t.update(region.fields.region.fields.isEnabled, true)
        const entities = resolveInsertedProjectEntities(region, t)
        return {
          region,
          ...entities,
          routing: canonical.routing,
          establishedTempo,
        }
      })
    } finally {
      removedRegionIds.forEach((regionId) => guardedRegionRemovalIds.delete(regionId))
    }
  }
  const inserted = deckNum <= 2
    ? await serializeSourceTiming(insertTransaction)
    : await insertTransaction()
  if (expectedSession !== tempoSessionId || nexus !== projectDocument) {
    throw new Error('Project connection changed during insertion')
  }

  if (inserted.establishedTempo) {
    currentProjectBpm = bpm
  }

  bindDeckRoutingGraph(deckIndex, projectDocument, inserted.routing, expectedSession)
  deck.scheduledCuePosition = 0
  deck.cuePosition = 0
  deck.sampleBpm = bpm
  deck.baseBpm = bpm
  deck.sampleMeta = sample
  resetDeckTempoState(deckIndex)
  bindDeckContentGraph(
    deckIndex,
    projectDocument,
    {
      region: inserted.region,
      sample: inserted.sample,
      automationCollection: inserted.automationCollection,
    },
    expectedSession,
  )
  if (deckNum <= 2) {
    updateManualBpmReportUi((deckNum - 1) as 0 | 1)
  }
  updateDeckBpmLabel((deckNum - 1) as WaveformDeckIndex)
  applyCurrentDeckEq((deckNum - 1) as WaveformDeckIndex)
  void applyCurrentDeckFilters((deckNum - 1) as WaveformDeckIndex)
  void applyCurrentDeckLevels((deckNum - 1) as WaveformDeckIndex)
  return inserted
}

async function uploadToNexus(
  deckNum: number,
  file: File,
  forceMagicLoop = false,
  expectedSession = tempoSessionId,
  options: UploadToNexusOptions = {},
) {
  if (!nexus || !at) throw new Error('Connect an Audiotool project before loading audio')
  setStatus('connected', `UPLOADING ${file.name}…`)
  try {
    const sampleDisplayName = `${deckNum === 3 ? 'MAGIC DECK' : `DECK ${deckNum}`} — ${file.name}`
    const projectDisplayName = deckNum === 3 ? 'MAGIC DECK' : sampleDisplayName
    const sourceDeckIndex = deckNum <= 2 ? (deckNum - 1) as 0 | 1 : null
    if (sourceDeckIndex !== null) {
      deckOperationStates[sourceDeckIndex].uploading = true
      updateSourceDeckUi(sourceDeckIndex)
    }
    const sample = await uploadSample(
      file,
      sampleDisplayName,
      options.timing?.bpm,
      options.sampleDescription,
    )
      .finally(() => {
        if (sourceDeckIndex === null) return
        deckOperationStates[sourceDeckIndex].uploading = false
        updateSourceDeckUi(sourceDeckIndex)
      })
    if (expectedSession !== tempoSessionId || !nexus) throw new Error('Project connection changed during upload')
    const resolution = deckNum <= 2 ? await resolveSampleBpm(sample, file, deckNum, expectedSession) : undefined
    if (expectedSession !== tempoSessionId || !nexus) throw new Error('Project connection changed during BPM selection')
    if (deckNum <= 2 && !resolution) {
      setStatus('connected', `DECK ${deckNum}: BPM ENTRY CANCELLED — SAMPLE NOT INSERTED`)
      return false
    }
    if (resolution?.source === 'project') {
      setStatus('connected', `DECK ${deckNum}: BPM UNKNOWN — ASSUMING PROJECT BPM ${resolution.bpm}`)
    } else if (resolution?.source === 'manual') {
      setStatus('connected', `DECK ${deckNum}: MANUAL BPM ${resolution.bpm} SELECTED`)
    }
    const deckIndex = (deckNum - 1) as WaveformDeckIndex
    const placement = options.placement ?? await captureDeckInsertionPlacement(deckIndex)
    if (!placement) {
      if (deckNum === 3) {
        setMagicStatus('warning', 'PLACEMENT CANCELLED · PREVIOUS MAGIC DECK PRESERVED')
      }
      setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: PLACEMENT CANCELLED — SAMPLE NOT INSERTED`)
      return false
    }
    if (expectedSession !== tempoSessionId || !nexus) {
      throw new Error('Project connection changed during placement capture')
    }
    setStatus('connected', `DECK ${deckNum}: SAMPLE READY — INSERTING PROJECT REGION…`)
    const inserted = await insertSampleIntoProject(
      deckNum,
      sample,
      projectDisplayName,
      forceMagicLoop,
      placement,
      resolution ?? undefined,
      expectedSession,
      options.timing,
    )
    if (deckNum <= 2) {
      void initializeDeckCues(deckIndex, sample)
      setStatus('connected', inserted.establishedTempo
        ? `DECK ${deckNum}: MASTER TEMPO SET TO ${resolution!.bpm} BPM — NATIVE SPEED PRESERVED ✓`
        : `DECK ${deckNum}: ${file.name} — NATIVE SPEED PRESERVED ✓`)
    } else {
      setStatus('connected', `DECK ${deckNum}: ${file.name} — SYNCHRONIZED TO PROJECT TEMPO ✓`)
    }
    return true
  } catch (e: unknown) {
    setStatus('error', `UPLOAD ERROR: ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
}

function removeDeckContentInTransaction(
  t: SafeTransactionBuilder,
  regionId: string | undefined,
  storedSampleId: string | undefined,
  storedAutomationCollectionId: string | undefined,
  sourceDeckIndex?: 0 | 1,
) {
  const region = regionId
    ? t.entities.ofTypes('audioRegion').getEntity(regionId)
    : undefined
  const sampleId = region?.fields.sample.value.entityId ?? storedSampleId
  const regionsToRemove = region
    ? sourceDeckIndex === undefined
      ? contiguousAudioRegions(t.entities, region)
      : sourceDeckInstanceRegions(t.entities, sourceDeckIndex, region)
    : []
  const removedRegionIds = new Set(regionsToRemove.map((candidate) => candidate.id))
  const automationCollectionIds = new Set(
    regionsToRemove.map((candidate) =>
      candidate.fields.playbackAutomationCollection.value.entityId),
  )
  if (storedAutomationCollectionId) automationCollectionIds.add(storedAutomationCollectionId)
  regionsToRemove.forEach((candidate) => t.remove(candidate))

  const sampleStillUsed = sampleId
    ? t.entities
      .ofTypes('audioRegion')
      .get()
      .some((candidate) =>
        !removedRegionIds.has(candidate.id)
        && candidate.fields.sample.value.entityId === sampleId)
    : false
  const sample = sampleId && !sampleStillUsed
    ? t.entities.ofTypes('sample').getEntity(sampleId)
    : undefined
  if (sample) t.removeWithDependencies(sample)

  automationCollectionIds.forEach((automationCollectionId) => {
    const automationStillUsed = t.entities
      .ofTypes('audioRegion')
      .get()
      .some((candidate) =>
        !removedRegionIds.has(candidate.id)
        && candidate.fields.playbackAutomationCollection.value.entityId === automationCollectionId)
    const automationCollection = !automationStillUsed
      ? t.entities.ofTypes('automationCollection').getEntity(automationCollectionId)
      : undefined
    if (automationCollection) t.removeWithDependencies(automationCollection)
  })
}

async function removeDeckProjectContent(deckIndex: 0 | 1, expectedSession: number) {
  const deck = decks[deckIndex]
  const operation = deckOperationStates[deckIndex]
  const projectDocument = nexus
  if (!projectDocument || !projectConnected || expectedSession !== tempoSessionId) {
    throw new Error('Project is not connected')
  }

  await serializeSourceTiming(async () => {
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
    ) {
      throw new Error('Project connection changed before deck removal')
    }

    const regionId = deck.regionEntity?.id
    const storedSampleId = deck.sampleEntity?.id
    const storedAutomationCollectionId = deck.automationCollectionEntity?.id
    if (!regionId) throw new Error('The synchronized project content is no longer available')

    operation.suppressProjectRemovalSync = true
    try {
      await projectDocument.modify((t) => {
        removeDeckContentInTransaction(
          t,
          regionId,
          storedSampleId,
          storedAutomationCollectionId,
          deckIndex,
        )
      })
      clearDeckContentEntities(deck)
    } finally {
      operation.suppressProjectRemovalSync = false
    }
  })
}

async function removeMagicDeckProjectContent(expectedSession: number) {
  const magicDeck = decks[2]
  const projectDocument = nexus
  if (!projectDocument || !projectConnected || expectedSession !== tempoSessionId) {
    throw new Error('Project is not connected')
  }

  const regionId = magicDeck.regionEntity?.id
  const storedSampleId = magicDeck.sampleEntity?.id
  const storedAutomationCollectionId = magicDeck.automationCollectionEntity?.id
  if (!regionId) return

  suppressMagicProjectRemovalSync = true
  try {
    await projectDocument.modify((t) => {
      removeDeckContentInTransaction(
        t,
        regionId,
        storedSampleId,
        storedAutomationCollectionId,
      )
    })
    clearDeckContentEntities(magicDeck)
  } finally {
    suppressMagicProjectRemovalSync = false
  }
}

async function applyDeckEq(deckIndex: WaveformDeckIndex, band: EqBand, value: number) {
  const deck = decks[deckIndex]
  if (!nexus || !deck.mixerChannelEntity) {
    setStatus('connected', `DECK ${deckIndex + 1}: LOAD AUDIO TO ENABLE PROJECT EQ`)
    return
  }

  const gainDb = knobValueToEqDb(value)
  try {
    await nexus.modify((t) => {
      const channel = t.entities.ofTypes('mixerChannel').getEntity(deck.mixerChannelEntity!.id) ?? deck.mixerChannelEntity!
      if (band === 'low') t.update(channel.fields.eq.fields.lowShelfGainDb, gainDb)
      if (band === 'mid') {
        t.update(channel.fields.eq.fields.lowMidGainDb, gainDb)
        t.update(channel.fields.eq.fields.highMidGainDb, gainDb)
      }
      if (band === 'hi') t.update(channel.fields.eq.fields.highShelfGainDb, gainDb)
    })
  } catch (e) {
    console.warn('[NEXUS] eq update:', e)
    setStatus('error', `EQ UPDATE FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function applyCurrentDeckEq(deckIndex: WaveformDeckIndex) {
  const bands = ['hi', 'mid', 'low'] as const
  bands.forEach((band) => {
    const canvas = el<HTMLCanvasElement>(`d${deckIndex + 1}-${band}`)
    const state = knobState.get(canvas)
    if (state) void applyDeckEq(deckIndex, band, state.value)
  })
}

function formatFilterFrequency(frequencyHz: number) {
  if (frequencyHz >= 1000) {
    const kilohertz = frequencyHz / 1000
    return `${kilohertz >= 10 ? Math.round(kilohertz) : kilohertz.toFixed(1)} kHz`
  }
  return `${Math.round(frequencyHz)} Hz`
}

function updateFilterKnobAccessibility(canvas: HTMLCanvasElement, value: number) {
  const frequencyHz = filterValueToFrequency(value)
  canvas.setAttribute('aria-valuenow', String(Math.round(frequencyHz)))
  canvas.setAttribute('aria-valuetext', formatFilterFrequency(frequencyHz))
}

function setDeckFilterKnobValue(
  deckIndex: WaveformDeckIndex,
  kind: DeckFilterKind,
  value: number,
) {
  const canvas = el<HTMLCanvasElement>(`d${deckIndex + 1}-${kind}`)
  const state = knobState.get(canvas)
  if (!state) return
  state.value = clampUnit(value)
  drawKnob(canvas, state.value)
  updateFilterKnobAccessibility(canvas, state.value)
}

function hydrateDeckFilterControls(
  deckIndex: WaveformDeckIndex,
  mixerChannel: NexusEntity<'mixerChannel'>,
) {
  const trimFilter = mixerChannel.fields.trimFilter.fields
  const isActive = trimFilter.isActive.value
  setDeckFilterKnobValue(
    deckIndex,
    'hpf',
    isActive
      ? filterFrequencyToValue(trimFilter.highPassCutoffFrequencyHz.value)
      : neutralFilterValue('hpf'),
  )
  setDeckFilterKnobValue(
    deckIndex,
    'lpf',
    isActive
      ? filterFrequencyToValue(trimFilter.lowPassCutoffFrequencyHz.value)
      : neutralFilterValue('lpf'),
  )
}

async function applyDeckFilters(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const projectDocument = nexus
  const mixerChannelId = deck.mixerChannelEntity?.id
  if (!projectDocument || !mixerChannelId) {
    setStatus('connected', `DECK ${deckIndex + 1}: LOAD AUDIO TO ENABLE PROJECT FILTERS`)
    return
  }

  const highPassState = knobState.get(el<HTMLCanvasElement>(`d${deckIndex + 1}-hpf`))
  const lowPassState = knobState.get(el<HTMLCanvasElement>(`d${deckIndex + 1}-lpf`))
  if (!highPassState || !lowPassState) return

  const highPassCutoffFrequencyHz = filterValueToFrequency(highPassState.value)
  const lowPassCutoffFrequencyHz = filterValueToFrequency(lowPassState.value)
  try {
    await projectDocument.modify((t) => {
      if (
        nexus !== projectDocument
        || deck.mixerChannelEntity?.id !== mixerChannelId
      ) throw new Error('Project routing changed before the filter update')
      const channel = t.entities.ofTypes('mixerChannel').getEntity(mixerChannelId)
      if (!channel) throw new Error('Deck mixer channel is no longer available')
      const trimFilter = channel.fields.trimFilter.fields
      t.update(trimFilter.highPassCutoffFrequencyHz, highPassCutoffFrequencyHz)
      t.update(trimFilter.lowPassCutoffFrequencyHz, lowPassCutoffFrequencyHz)
      t.update(trimFilter.isActive, true)
    })
  } catch (e) {
    console.warn('[NEXUS] filter update:', e)
    setStatus('error', `FILTER UPDATE FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function applyCurrentDeckFilters(deckIndex: WaveformDeckIndex) {
  return applyDeckFilters(deckIndex)
}

async function applyDeckProjectLevels(
  deckIndex: WaveformDeckIndex,
  recordVolumeAutomation = false,
) {
  const deck = decks[deckIndex]
  const projectDocument = nexus
  const mixerChannelId = deck.mixerChannelEntity?.id
  if (!projectDocument || !mixerChannelId) {
    setStatus('connected', `DECK ${deckIndex + 1}: LOAD AUDIO TO ENABLE PROJECT LEVELS`)
    return
  }

  try {
    await projectDocument.modify((t) => {
      if (
        nexus !== projectDocument
        || deck.mixerChannelEntity?.id !== mixerChannelId
      ) {
        throw new Error('Project routing changed before the level update')
      }
      const channel = t.entities.ofTypes('mixerChannel').getEntity(mixerChannelId)
      if (!channel) throw new Error('Deck mixer channel is no longer available')
      const regionId = deck.regionEntity?.id
      const region = regionId
        ? t.entities.ofTypes('audioRegion').getEntity(regionId)
        : null
      if (recordVolumeAutomation && region) {
        replaceDeckVolumeAutomation(t, deckIndex, channel, region, deck.volume)
      } else {
        t.update(channel.fields.faderParameters.fields.postGain, deck.volume)
      }
      t.update(channel.fields.preGain, PROJECT_PRE_GAIN_BASE * deck.gainTrim)
    })
  } catch (e) {
    console.warn('[NEXUS] level update:', e)
    setStatus('error', `LEVEL UPDATE FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function applyCurrentDeckLevels(deckIndex: WaveformDeckIndex) {
  return applyDeckProjectLevels(deckIndex, true)
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value))
}

function deckFxValues(fxGraph: DeckFxGraph): Record<DeckFxKind, number> {
  return {
    delay: fxGraph.delay.fields.isActive.value
      ? clampUnit(fxGraph.delay.fields.mix.value)
      : 0,
    reverb: fxGraph.reverb.fields.isActive.value
      ? clampUnit(fxGraph.reverb.fields.mix.value)
      : 0,
    distortion: fxGraph.distortion.fields.isActive.value
      ? clampUnit((fxGraph.distortion.fields.drive.value - 0.1) / 11.9)
      : 0,
    flanger: fxGraph.flanger.fields.isActive.value
      ? clampUnit(fxGraph.flanger.fields.lfoModulationDepth.value)
      : 0,
  }
}

function setDeckFxKnobValue(
  deckIndex: WaveformDeckIndex,
  kind: DeckFxKind,
  value: number,
) {
  const controls = getDeckFxElements(deckIndex)
  const canvas = controls.knobs[kind]
  const state = knobState.get(canvas)
  if (!state) return
  state.value = clampUnit(value)
  drawKnob(canvas, state.value)
  canvas.setAttribute('aria-valuenow', String(Math.round(state.value * 100)))
  controls.outputs[kind].value = `${Math.round(state.value * 100)}%`
}

function hydrateDeckFxControls(deckIndex: WaveformDeckIndex, fxGraph: DeckFxGraph) {
  const values = deckFxValues(fxGraph)
  DECK_FX_KINDS.forEach((kind) => {
    setDeckFxKnobValue(deckIndex, kind, values[kind])
  })
}

async function applyDeckFx(
  deckIndex: WaveformDeckIndex,
  kind: DeckFxKind,
  value: number,
) {
  const projectDocument = nexus
  const fxGraph = decks[deckIndex].fxGraph
  const expectedSession = tempoSessionId
  if (
    !projectDocument
    || !projectConnected
    || !fxGraph
    || activeFxDeckIndex !== deckIndex
  ) return
  const normalizedValue = clampUnit(value)

  try {
    await projectDocument.modify((t) => {
      if (
        nexus !== projectDocument
        || !projectConnected
        || expectedSession !== tempoSessionId
      ) throw new Error('Project connection changed during FX update')
      const currentGraph = reusableDeckGraphs(t.entities, deckIndex)[0]?.routing.fxGraph
      if (
        !currentGraph
        || currentGraph.delay.id !== fxGraph.delay.id
        || currentGraph.reverb.id !== fxGraph.reverb.id
        || currentGraph.distortion.id !== fxGraph.distortion.id
        || currentGraph.flanger.id !== fxGraph.flanger.id
      ) {
        throw new Error('The synchronized FX chain changed')
      }
      const { delay, reverb, distortion, flanger } = currentGraph
      const enabled = normalizedValue > 0
      if (kind === 'delay') {
        t.update(delay.fields.mix, normalizedValue)
        t.update(delay.fields.isActive, enabled)
      } else if (kind === 'reverb') {
        t.update(reverb.fields.mix, normalizedValue)
        t.update(reverb.fields.isActive, enabled)
      } else if (kind === 'distortion') {
        t.update(distortion.fields.drive, 0.1 + normalizedValue * 11.9)
        t.update(distortion.fields.isActive, enabled)
      } else {
        t.update(flanger.fields.feedbackFactor, normalizedValue * 0.75)
        t.update(flanger.fields.lfoFrequencyHz, 0.1 + normalizedValue * 1.9)
        t.update(flanger.fields.lfoModulationDepth, normalizedValue)
        t.update(flanger.fields.isActive, enabled)
      }
    })
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
      || activeFxDeckIndex !== deckIndex
    ) return
    getDeckFxElements(deckIndex).error.textContent = ''
  } catch (error) {
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
      || activeFxDeckIndex !== deckIndex
    ) return
    const message = error instanceof Error ? error.message : String(error)
    getDeckFxElements(deckIndex).error.textContent =
      `FX UPDATE FAILED: ${message.toUpperCase()}`
    setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: FX UPDATE FAILED — ${message}`)
  }
}

function formatLibraryFileSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatLibraryModified(lastModified: number) {
  if (!lastModified) return '—'
  return new Date(lastModified).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  })
}

function visibleMusicLibraryNodes(deckIndex: 0 | 1) {
  const state = musicLibraryPickerStates[deckIndex]
  return flattenMusicLibraryTree(musicLibraryTree, {
    expandedFolderIds: state.expandedFolderIds,
    query: state.query,
    sortKey: state.sortKey,
    sortDirection: state.sortDirection,
  })
}

function focusSelectedMusicLibraryRow(deckIndex: 0 | 1) {
  const controls = getDeckLibraryElements(deckIndex)
  const selected = controls.list.querySelector<HTMLElement>('[aria-selected="true"]')
  if (selected) {
    selected.focus()
    selected.scrollIntoView({ block: 'nearest' })
  } else {
    controls.search.focus()
  }
}

function selectMusicLibraryNode(deckIndex: 0 | 1, nodeId: string, focus = false) {
  const state = musicLibraryPickerStates[deckIndex]
  state.selectedId = nodeId
  const controls = getDeckLibraryElements(deckIndex)
  const rows = Array.from(controls.list.querySelectorAll<HTMLElement>('.deck-library-row'))
  if (rows.length === 0) {
    renderDeckLibraryView(deckIndex)
  } else {
    rows.forEach((row) => {
      const selected = row.dataset.libraryNodeId === nodeId
      row.setAttribute('aria-selected', String(selected))
      row.tabIndex = selected ? 0 : -1
    })
    const selectedNode = findMusicLibraryNode(musicLibraryTree, state.selectedId)
    controls.load.disabled = selectedNode?.kind !== 'track'
      || !projectConnected
      || nexus === null
      || deckOperationStates[deckIndex].pendingCount > 0
  }
  if (focus) focusSelectedMusicLibraryRow(deckIndex)
}

function toggleMusicLibraryFolder(
  deckIndex: 0 | 1,
  folderId: string,
  expanded?: boolean,
  focus = true,
) {
  const state = musicLibraryPickerStates[deckIndex]
  state.selectedId = folderId
  if (state.query.trim()) {
    if (focus) focusSelectedMusicLibraryRow(deckIndex)
    return
  }
  const shouldExpand = expanded ?? !state.expandedFolderIds.has(folderId)
  if (shouldExpand) state.expandedFolderIds.add(folderId)
  else state.expandedFolderIds.delete(folderId)
  renderDeckLibraryView(deckIndex)
  if (focus) requestAnimationFrame(() => focusSelectedMusicLibraryRow(deckIndex))
}

function handleMusicLibraryRowKey(
  event: KeyboardEvent,
  deckIndex: 0 | 1,
  entryId: string,
) {
  const controls = getDeckLibraryElements(deckIndex)
  if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
    event.preventDefault()
    controls.search.focus()
    controls.search.select()
    return
  }
  if (event.key === '/') {
    event.preventDefault()
    controls.search.focus()
    controls.search.select()
    return
  }
  if (![
    'Enter',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ].includes(event.key)) return
  event.preventDefault()
  const action = musicLibraryTreeKeyAction(
    visibleMusicLibraryNodes(deckIndex),
    entryId,
    event.key,
    MUSIC_LIBRARY_PAGE_SIZE,
  )
  if (!action.id || action.type === 'none') return
  if (action.type === 'select') selectMusicLibraryNode(deckIndex, action.id, true)
  else if (action.type === 'expand') toggleMusicLibraryFolder(deckIndex, action.id, true)
  else if (action.type === 'collapse') toggleMusicLibraryFolder(deckIndex, action.id, false)
  else if (action.type === 'activate') {
    selectMusicLibraryNode(deckIndex, action.id)
    void loadSelectedMusicLibraryEntry(deckIndex)
  }
}

function renderDeckLibraryView(deckIndex: 0 | 1) {
  const controls = getDeckLibraryElements(deckIndex)
  const state = musicLibraryPickerStates[deckIndex]
  const visibleNodes = visibleMusicLibraryNodes(deckIndex)
  state.selectedId = recoverMusicLibrarySelectionId(state.selectedId, visibleNodes)
  controls.search.value = state.query
  const matchingTrackCount = state.query.trim()
    ? visibleNodes.filter(({ node }) => node.kind === 'track').length
    : musicLibraryEntries.length
  controls.count.textContent = `${matchingTrackCount}/${musicLibraryEntries.length}`
  controls.grid.setAttribute('aria-rowcount', String(visibleNodes.length + 1))
  controls.list.replaceChildren()

  if (visibleNodes.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'deck-library-empty'
    empty.textContent = musicLibraryEntries.length === 0
      ? 'NO MP3 OR WAV FILES FOUND'
      : 'NO MATCHING TRACKS'
    controls.list.append(empty)
  } else {
    visibleNodes.forEach(({ node, depth, expanded }, index) => {
      const row = document.createElement('div')
      const selected = node.id === state.selectedId
      row.className = 'deck-library-row'
      row.id = `deck${deckIndex + 1}-library-row-${index}`
      row.setAttribute('role', 'row')
      row.setAttribute('aria-rowindex', String(index + 2))
      row.setAttribute('aria-selected', String(selected))
      row.setAttribute('aria-level', String(depth + 1))
      row.setAttribute('aria-label', `${node.kind === 'folder' ? 'Folder' : 'Track'} ${node.name}`)
      if (node.kind === 'folder') row.setAttribute('aria-expanded', String(expanded))
      row.dataset.libraryNodeId = node.id
      row.tabIndex = selected ? 0 : -1

      const nameCell = document.createElement('div')
      nameCell.className = 'deck-library-cell deck-library-name-cell'
      nameCell.setAttribute('role', 'gridcell')
      nameCell.setAttribute('aria-colindex', '1')
      nameCell.style.setProperty('--tree-depth', String(depth))
      nameCell.title = node.relativePath
      if (node.kind === 'folder') {
        const disclosure = document.createElement('button')
        disclosure.className = 'deck-library-disclosure'
        disclosure.type = 'button'
        disclosure.tabIndex = -1
        disclosure.disabled = Boolean(state.query.trim())
        disclosure.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} folder ${node.name}`)
        const icon = document.createElement('span')
        icon.setAttribute('aria-hidden', 'true')
        icon.textContent = expanded ? '📂' : '📁'
        disclosure.append(icon)
        disclosure.addEventListener('click', (event) => {
          event.stopPropagation()
          toggleMusicLibraryFolder(deckIndex, node.id, !expanded)
        })
        disclosure.addEventListener('dblclick', (event) => event.stopPropagation())
        nameCell.append(disclosure)
      } else {
        const icon = document.createElement('span')
        icon.className = 'deck-library-track-icon'
        icon.setAttribute('aria-hidden', 'true')
        icon.textContent = '♫'
        nameCell.append(icon)
      }
      const name = document.createElement('span')
      name.className = 'deck-library-node-name'
      name.textContent = node.name
      nameCell.append(name)
      row.append(nameCell)

      const values = node.kind === 'track'
        ? [formatLibraryFileSize(node.size), formatLibraryModified(node.lastModified)]
        : ['—', '—']
      values.forEach((value, valueIndex) => {
        const cell = document.createElement('div')
        cell.className = 'deck-library-cell'
        cell.setAttribute('role', 'gridcell')
        cell.setAttribute('aria-colindex', String(valueIndex + 2))
        cell.textContent = value
        cell.title = value
        row.append(cell)
      })
      row.addEventListener('click', () => selectMusicLibraryNode(deckIndex, node.id, true))
      row.addEventListener('dblclick', () => {
        if (node.kind === 'folder') toggleMusicLibraryFolder(deckIndex, node.id)
        else void loadSelectedMusicLibraryEntry(deckIndex)
      })
      row.addEventListener('keydown', (event) => handleMusicLibraryRowKey(event, deckIndex, node.id))
      controls.list.append(row)
    })
  }

  const sortLabels: Record<MusicLibrarySortKey, string> = {
    name: 'NAME',
    size: 'SIZE',
    modified: 'MODIFIED',
  }
  controls.sortButtons.forEach((button) => {
    const key = button.dataset.librarySort as MusicLibrarySortKey
    const active = key === state.sortKey
    button.textContent = `${sortLabels[key]}${active ? state.sortDirection === 'ascending' ? ' ▲' : ' ▼' : ''}`
    if (active) button.setAttribute('aria-sort', state.sortDirection)
    else button.removeAttribute('aria-sort')
  })

  const operation = deckOperationStates[deckIndex]
  const selectedNode = findMusicLibraryNode(musicLibraryTree, state.selectedId)
  controls.load.textContent = isSourceDeckSynchronized(deckIndex) ? 'REPLACE' : 'LOAD'
  controls.load.disabled = selectedNode?.kind !== 'track'
    || !projectConnected
    || nexus === null
    || operation.pendingCount > 0
  controls.load.title = projectConnected ? '' : 'Connect an Audiotool project before loading audio'
}

function renderDeckLibraryAvailability() {
  for (const deckIndex of [0, 1] as const) {
    const controls = getDeckLibraryElements(deckIndex)
    const operation = deckOperationStates[deckIndex]
    const bpmFormOpen = !el<HTMLDivElement>(`deck${deckIndex + 1}-bpm-form`).classList.contains('is-hidden')
    const bpmReportOpen = manualBpmReportStates[deckIndex].editing
    const barFormOpen = controls.assistant.classList.contains('bar-assistant-active')
    controls.trigger.disabled = operation.pendingCount > 0
      || decks[deckIndex].tempoUpdatePending
      || bpmFormOpen
      || bpmReportOpen
      || barFormOpen
      || activeFxDeckIndex !== null
      || activeLibraryDeckIndex === deckIndex
      || musicLibraryConnectionState === 'busy'
  }
}

function closeDeckLibraryAssistant(restoreFocus = true) {
  const deckIndex = activeLibraryDeckIndex
  if (deckIndex === null) return
  const controls = getDeckLibraryElements(deckIndex)
  activeLibraryDeckIndex = null
  controls.assistant.classList.remove('is-library-view')
  controls.view.classList.add('is-hidden')
  controls.error.textContent = ''
  renderDeckLibraryAvailability()
  renderDeckFxAvailability()
  if (restoreFocus) controls.trigger.focus()
}

function showDeckLibraryAssistant(deckIndex: 0 | 1) {
  if (musicLibraryConnectionState !== 'ready') {
    setStatus('connected', 'CHOOSE A GLOBAL MUSIC FOLDER BEFORE BROWSING THE LIBRARY')
    btnMusicLibraryChoose.focus()
    return
  }
  if (activeFxDeckIndex !== null) closeDeckFxAssistant(false)
  if (activeLibraryDeckIndex !== null) closeDeckLibraryAssistant(false)
  const controls = getDeckLibraryElements(deckIndex)
  activeLibraryDeckIndex = deckIndex
  controls.error.textContent = ''
  controls.assistant.classList.add('is-library-view')
  controls.view.classList.remove('is-hidden')
  renderDeckLibraryView(deckIndex)
  renderDeckLibraryAvailability()
  renderDeckFxAvailability()
  controls.assistant.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  requestAnimationFrame(() => focusSelectedMusicLibraryRow(deckIndex))
}

async function loadSelectedMusicLibraryEntry(deckIndex: 0 | 1) {
  if (activeLibraryDeckIndex !== deckIndex) return
  const controls = getDeckLibraryElements(deckIndex)
  const entry = findMusicLibraryNode(
    musicLibraryTree,
    musicLibraryPickerStates[deckIndex].selectedId,
  )
  if (!entry || entry.kind !== 'track') return
  if (!projectConnected || !nexus) {
    controls.error.textContent = 'CONNECT AN AUDIOTOOL PROJECT BEFORE LOADING'
    return
  }

  closeDeckLibraryAssistant(false)
  setStatus('connecting', `${placementDeckLabel(deckIndex).toUpperCase()}: CAPTURING AUDIOTOOL BAR…`)
  try {
    const placement = await captureDeckInsertionPlacement(deckIndex)
    if (!placement) {
      setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: LOAD CANCELLED — PROJECT CONTENT PRESERVED`)
      return
    }
    const file = entry.fileHandle ? await entry.fileHandle.getFile() : entry.file
    if (!file) throw new Error('The selected track is no longer available')
    if (!isSupportedMusicFile(file.name)) throw new Error('Only MP3 and WAV files are supported')
    queueDeckLoad(deckIndex, file, placement)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showDeckLibraryAssistant(deckIndex)
    getDeckLibraryElements(deckIndex).error.textContent = `${message.toUpperCase()} · REFRESH THE MUSIC LIBRARY`
    setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: LOAD FAILED — ${message}`)
  }
}

function setupDeckLibraryPicker(deckIndex: 0 | 1) {
  const controls = getDeckLibraryElements(deckIndex)
  controls.trigger.addEventListener('click', () => showDeckLibraryAssistant(deckIndex))
  controls.back.addEventListener('click', () => closeDeckLibraryAssistant())
  controls.load.addEventListener('click', () => { void loadSelectedMusicLibraryEntry(deckIndex) })
  controls.search.addEventListener('input', () => {
    musicLibraryPickerStates[deckIndex].query = controls.search.value
    renderDeckLibraryView(deckIndex)
  })
  controls.search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusSelectedMusicLibraryRow(deckIndex)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (controls.search.value) {
        musicLibraryPickerStates[deckIndex].query = ''
        renderDeckLibraryView(deckIndex)
        controls.search.focus()
      } else {
        closeDeckLibraryAssistant()
      }
    }
  })
  controls.view.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return
    if (
      event.target !== controls.search
      && (event.key === '/'
        || ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f'))
    ) {
      event.preventDefault()
      controls.search.focus()
      controls.search.select()
      return
    }
    if (event.key === 'Escape' && event.target !== controls.search) {
      event.preventDefault()
      if (musicLibraryPickerStates[deckIndex].query) {
        musicLibraryPickerStates[deckIndex].query = ''
        renderDeckLibraryView(deckIndex)
        controls.search.focus()
      } else {
        closeDeckLibraryAssistant()
      }
    }
  })
  controls.sortButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const state = musicLibraryPickerStates[deckIndex]
      const key = button.dataset.librarySort as MusicLibrarySortKey
      if (state.sortKey === key) {
        state.sortDirection = state.sortDirection === 'ascending' ? 'descending' : 'ascending'
      } else {
        state.sortKey = key
        state.sortDirection = 'ascending'
      }
      renderDeckLibraryView(deckIndex)
      focusSelectedMusicLibraryRow(deckIndex)
    })
  })
}

function setDeckFxAssistantView(
  deckIndex: WaveformDeckIndex,
  visible: boolean,
  loading = false,
) {
  const controls = getDeckFxElements(deckIndex)
  if (visible && !controls.assistant.classList.contains('is-fx-view')) {
    controls.assistant.style.height = `${controls.assistant.getBoundingClientRect().height}px`
  }
  controls.assistant.classList.toggle('is-fx-view', visible)
  controls.assistant.classList.toggle('is-fx-loading', visible && loading)
  controls.assistant.setAttribute('aria-busy', String(visible && loading))
  controls.view.classList.toggle('is-hidden', !visible)
  controls.headerButtons.forEach((button) => { button.disabled = visible })
  if (!visible) controls.assistant.style.height = ''
}

function closeDeckFxAssistant(restoreFocus = true) {
  const deckIndex = activeFxDeckIndex
  const trigger = activeFxTrigger
  deckFxAssistantRequestId += 1
  activeFxDeckIndex = null
  activeFxTrigger = null
  if (deckIndex !== null) {
    setDeckFxAssistantView(deckIndex, false)
    if (deckIndex < 2) updateSourceDeckUi(deckIndex as 0 | 1)
  }
  document.removeEventListener('keydown', handleDeckFxAssistantKey)
  renderDeckFxAvailability()
  if (restoreFocus && trigger && !trigger.disabled && trigger.isConnected) trigger.focus()
}

function handleDeckFxAssistantKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || activeFxDeckIndex === null) return
  event.preventDefault()
  closeDeckFxAssistant()
}

async function showDeckFxAssistant(deckIndex: WaveformDeckIndex) {
  if (activeLibraryDeckIndex !== null) closeDeckLibraryAssistant(false)
  const projectDocument = nexus
  const expectedSession = tempoSessionId
  if (!projectDocument || !projectConnected) {
    setStatus('error', 'CONNECT AN AUDIOTOOL PROJECT TO OPEN DECK FX')
    return
  }
  if (activeFxDeckIndex === deckIndex) return
  if (activeFxDeckIndex !== null) closeDeckFxAssistant(false)

  const trigger = document.querySelector<HTMLButtonElement>(`[data-deck-fx="${deckIndex}"]`)
  const controls = getDeckFxElements(deckIndex)
  const requestId = deckFxAssistantRequestId + 1
  deckFxAssistantRequestId = requestId
  activeFxDeckIndex = deckIndex
  activeFxTrigger = trigger ?? null
  controls.error.textContent = ''
  setDeckFxAssistantView(deckIndex, true, true)
  document.removeEventListener('keydown', handleDeckFxAssistantKey)
  document.addEventListener('keydown', handleDeckFxAssistantKey)
  controls.assistant.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  setStatus('connecting', `${placementDeckLabel(deckIndex).toUpperCase()}: PREPARING PROJECT FX…`)

  try {
    const routing = await ensureDeckFxGraph(projectDocument, deckIndex, expectedSession)
    if (
      nexus !== projectDocument
      || !projectConnected
      || expectedSession !== tempoSessionId
      || !routing.fxGraph
    ) throw new Error('Project connection changed while opening FX')
    if (activeFxDeckIndex !== deckIndex || deckFxAssistantRequestId !== requestId) return
    bindDeckFxRoutingGraph(deckIndex, projectDocument, routing, expectedSession)
    if (activeFxDeckIndex !== deckIndex || deckFxAssistantRequestId !== requestId) return
    hydrateDeckFxControls(deckIndex, routing.fxGraph)
    setDeckFxAssistantView(deckIndex, true)
    setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: FX READY ↔ PROJECT SYNCED`)
    controls.knobs.delay.focus()
  } catch (error) {
    if (activeFxDeckIndex !== deckIndex || deckFxAssistantRequestId !== requestId) return
    const message = error instanceof Error ? error.message : String(error)
    setDeckFxAssistantView(deckIndex, true)
    controls.error.textContent = `FX PREPARATION FAILED: ${message.toUpperCase()}`
    setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: FX FAILED — ${message}`)
    controls.back.focus()
  }
}

function renderDeckFxAvailability() {
  document.querySelectorAll<HTMLButtonElement>('[data-deck-fx]').forEach((button) => {
    const deckIndex = Number(button.dataset.deckFx) as WaveformDeckIndex
    button.disabled = !projectConnected
      || nexus === null
      || activeFxDeckIndex === deckIndex
      || activeLibraryDeckIndex !== null
  })
  if (!projectConnected && activeFxDeckIndex !== null) closeDeckFxAssistant()
  if (activeFxDeckIndex !== null) {
    getDeckFxElements(activeFxDeckIndex).headerButtons.forEach((button) => {
      button.disabled = true
    })
  }
}

// ── AUDIO ─────────────────────────────────────────────────────────────────────
function ensureCtx(deck: DeckState) {
  if (!deck.audioCtx) deck.audioCtx = new AudioContext()
}
async function loadAudioFile(
  deckIndex: 0 | 1,
  file: File,
  expectedSession: number,
  placement: DeckInsertionPlacement,
) {
  const deck = decks[deckIndex]
  const operation = deckOperationStates[deckIndex]
  const replacing = isSourceDeckSynchronized(deckIndex)
  operation.activeKind = replacing ? 'replacing' : 'loading'
  updateSourceDeckUi(deckIndex)
  setStatus('connecting', `DECK ${deckIndex + 1}: ${replacing ? 'PREPARING REPLACEMENT' : 'PREPARING UPLOAD'}…`)

  if (replacing) {
    setStatus('connecting', `DECK ${deckIndex + 1}: PRESERVING HISTORY — PREPARING FORWARD INSERTION…`)
  }

  const inserted = await uploadToNexus(deckIndex + 1, file, false, expectedSession, { placement })
  if (!inserted) {
    updateSourceDeckUi(deckIndex)
    return
  }
  if (expectedSession !== tempoSessionId) throw new Error('Project connection changed after insertion')

  deck.fileName = file.name
  updateSourceDeckUi(deckIndex)
}

function queueDeckLoad(deckIndex: 0 | 1, file: File, placement: DeckInsertionPlacement) {
  const operation = deckOperationStates[deckIndex]
  const expectedSession = tempoSessionId
  resetDeckCuePosition(deckIndex)
  operation.pendingCount += 1
  updateSourceDeckUi(deckIndex)
  deckLoadQueue = deckLoadQueue
    .then(async () => {
      if (expectedSession !== tempoSessionId) return
      await loadAudioFile(deckIndex, file, expectedSession, placement)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setStatus('error', `DECK ${deckIndex + 1}: LOAD OR REPLACEMENT FAILED — ${message}`)
    })
    .finally(() => {
      operation.pendingCount = Math.max(0, operation.pendingCount - 1)
      if (operation.pendingCount === 0) operation.activeKind = null
      updateSourceDeckUi(deckIndex)
    })
}

async function unloadSourceDeck(deckIndex: 0 | 1) {
  if (!isSourceDeckSynchronized(deckIndex)) return
  const expectedSession = tempoSessionId
  setStatus('connecting', `DECK ${deckIndex + 1}: UNLOADING — CLEARING PROJECT CONTENT…`)
  await removeDeckProjectContent(deckIndex, expectedSession)
  clearSourceDeckLocalMedia(deckIndex)
  updateSourceDeckUi(deckIndex)
  setStatus('connected', `DECK ${deckIndex + 1}: UNLOADED — PROJECT TRACK PRESERVED ✓`)
}

function queueDeckUnload(deckIndex: 0 | 1) {
  const operation = deckOperationStates[deckIndex]
  if (operation.pendingCount > 0 || !isSourceDeckSynchronized(deckIndex)) return
  const expectedSession = tempoSessionId
  operation.pendingCount += 1
  operation.activeKind = 'unloading'
  updateSourceDeckUi(deckIndex)
  deckLoadQueue = deckLoadQueue
    .then(() => {
      if (expectedSession !== tempoSessionId) return
      return unloadSourceDeck(deckIndex)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setStatus('error', `DECK ${deckIndex + 1}: UNLOAD FAILED — ${message}`)
    })
    .finally(() => {
      operation.pendingCount = Math.max(0, operation.pendingCount - 1)
      if (operation.pendingCount === 0) operation.activeKind = null
      updateSourceDeckUi(deckIndex)
    })
}

// ── WAVEFORM ──────────────────────────────────────────────────────────────────
function drawWaveformBase(canvas: HTMLCanvasElement, buf: AudioBuffer) {
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height, data = buf.getChannelData(0)
  const step = Math.ceil(data.length / W), mid = H / 2
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke()
  for (let i = 0; i < W; i++) {
    let lo = 1, hi = -1
    for (let j = 0; j < step; j++) { const d = data[i * step + j]; if (d !== undefined) { if (d < lo) lo = d; if (d > hi) hi = d } }
    ctx.strokeStyle = `rgb(${Math.round(60 + (i / W) * 144)},0,0)`
    ctx.beginPath(); ctx.moveTo(i, mid + lo * mid * 0.9); ctx.lineTo(i, mid + hi * mid * 0.9); ctx.stroke()
  }
}

function drawMagicPeakWaveform(peaks: readonly number[]) {
  const ctx = magicWaveform.getContext('2d')!
  const W = magicWaveform.width
  const H = magicWaveform.height
  const mid = H / 2
  const peakMax = Math.max(...peaks, 0.0001)
  ctx.fillStyle = '#050000'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#1a0000'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, mid)
  ctx.lineTo(W, mid)
  ctx.stroke()

  for (let x = 0; x < W; x++) {
    const start = Math.floor(x * peaks.length / W)
    const end = Math.max(start + 1, Math.floor((x + 1) * peaks.length / W))
    let peak = 0
    for (let index = start; index < end && index < peaks.length; index++) {
      peak = Math.max(peak, peaks[index])
    }
    const height = peak / peakMax * mid * 0.88
    ctx.strokeStyle = `rgb(${Math.round(90 + x / W * 130)}, 12, 18)`
    ctx.beginPath()
    ctx.moveTo(x + 0.5, mid - height)
    ctx.lineTo(x + 0.5, mid + height)
    ctx.stroke()
  }
}

function redrawMagicWaveform() {
  const deck = decks[2]
  if (deck.audioBuffer) {
    drawWaveformBase(magicWaveform, deck.audioBuffer)
  } else if (magicWaveformPeaks) {
    drawMagicPeakWaveform(magicWaveformPeaks)
  }
}

function drawMagicWaveform(buf: AudioBuffer) {
  magicWaveformPeaks = null
  drawWaveformBase(magicWaveform, buf)
}

// ── KNOBS ─────────────────────────────────────────────────────────────────────
function drawKnob(canvas: HTMLCanvasElement, value: number) {
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2, r = Math.min(W, H) / 2 - 4
  ctx.clearRect(0, 0, W, H)
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill(); ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1; ctx.stroke()
  const sA = Math.PI * 0.75, eA = Math.PI * 2.25, cA = sA + (eA - sA) * value
  ctx.beginPath(); ctx.arc(cx, cy, r - 5, sA, eA); ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, r - 5, sA, cA); ctx.strokeStyle = '#CC0000'; ctx.lineWidth = 4; ctx.stroke()
  const ix = cx + Math.cos(cA) * (r - 10), iy = cy + Math.sin(cA) * (r - 10)
  ctx.beginPath(); ctx.arc(ix, iy, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill()
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fillStyle = '#333'; ctx.fill()
}
function getDeckEqControl(canvas: HTMLCanvasElement): { deckIndex: WaveformDeckIndex; band: EqBand } | null {
  const match = canvas.id.match(/^d([123])-(hi|mid|low)$/)
  if (!match) return null
  return { deckIndex: Number(match[1]) - 1 as WaveformDeckIndex, band: match[2] as EqBand }
}
function getDeckFilterControl(
  canvas: HTMLCanvasElement,
): { deckIndex: WaveformDeckIndex; kind: DeckFilterKind } | null {
  const match = canvas.id.match(/^d([123])-(hpf|lpf)$/)
  if (!match) return null
  return {
    deckIndex: Number(match[1]) - 1 as WaveformDeckIndex,
    kind: match[2] as DeckFilterKind,
  }
}
function getDeckFxControl(
  canvas: HTMLCanvasElement,
): { deckIndex: WaveformDeckIndex; kind: DeckFxKind } | null {
  const kind = canvas.dataset.fx
  const assistant = canvas.closest<HTMLElement>('[data-deck-assistant]')
  const deckIndex = Number(assistant?.dataset.deckAssistant)
  const validKind = kind === 'delay'
    || kind === 'reverb'
    || kind === 'distortion'
    || kind === 'flanger'
    ? kind
    : null
  return validKind && (deckIndex === 0 || deckIndex === 1 || deckIndex === 2)
    ? { deckIndex, kind: validKind }
    : null
}
function initKnob(canvas: HTMLCanvasElement) {
  const init = parseFloat(canvas.dataset.value ?? '0.5')
  knobState.set(canvas, { value: init, dragging: false, startY: 0, startVal: init })
  drawKnob(canvas, init)

  // ── Accessibility: make canvas focusable + ARIA role ────────────────────────
  canvas.setAttribute('tabindex', '0')
  canvas.setAttribute('role', 'slider')
  canvas.setAttribute('aria-valuemin', '0')
  canvas.setAttribute('aria-valuemax', '100')
  canvas.setAttribute('aria-valuenow', String(Math.round(init * 100)))
  const label = canvas.id.match(/^d(\d)-(hi|mid|low)$/)
  if (label) canvas.setAttribute('aria-label', `Deck ${label[1]} ${label[2].toUpperCase()} EQ`)
  const filterControl = getDeckFilterControl(canvas)
  if (filterControl) {
    canvas.setAttribute(
      'aria-label',
      `${placementDeckLabel(filterControl.deckIndex)} ${filterControl.kind.toUpperCase()} cutoff frequency`,
    )
    canvas.setAttribute('aria-valuemin', String(DECK_FILTER_MIN_HZ))
    canvas.setAttribute('aria-valuemax', String(DECK_FILTER_MAX_HZ))
    updateFilterKnobAccessibility(canvas, init)
  }
  const fxControl = getDeckFxControl(canvas)
  if (fxControl) {
    canvas.setAttribute(
      'aria-label',
      `${placementDeckLabel(fxControl.deckIndex)} ${fxControl.kind} effect amount`,
    )
  }

  const updateValue = (newValue: number) => {
    const s = knobState.get(canvas)!
    s.value = Math.max(0, Math.min(1, newValue))
    drawKnob(canvas, s.value)
    canvas.setAttribute('aria-valuenow', String(Math.round(s.value * 100)))
    const control = getDeckEqControl(canvas)
    if (control) void applyDeckEq(control.deckIndex, control.band, s.value)
    const filter = getDeckFilterControl(canvas)
    if (filter) {
      updateFilterKnobAccessibility(canvas, s.value)
      void applyDeckFilters(filter.deckIndex)
    }
    const effect = getDeckFxControl(canvas)
    if (effect && activeFxDeckIndex === effect.deckIndex) {
      getDeckFxElements(effect.deckIndex).outputs[effect.kind].value =
        `${Math.round(s.value * 100)}%`
      void applyDeckFx(effect.deckIndex, effect.kind, s.value)
    }
  }

  // Mouse drag
  canvas.addEventListener('mousedown', (e) => {
    const s = knobState.get(canvas)!
    s.dragging = true; s.startY = e.clientY; s.startVal = s.value
    canvas.focus()
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    const s = knobState.get(canvas)
    if (!s?.dragging) return
    updateValue(s.startVal + (s.startY - e.clientY) / 120)
  })
  window.addEventListener('mouseup', () => { const s = knobState.get(canvas); if (s) s.dragging = false })

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  canvas.addEventListener('keydown', (e) => {
    const s = knobState.get(canvas)!
    const step = e.shiftKey ? 0.1 : 0.05  // coarse with Shift, fine without
    const bigStep = 0.25
    let newVal = s.value
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': newVal = s.value + step; break
      case 'ArrowDown': case 'ArrowLeft': newVal = s.value - step; break
      case 'PageUp': newVal = s.value + bigStep; break
      case 'PageDown': newVal = s.value - bigStep; break
      case 'Home': newVal = 0; break
      case 'End': newVal = 1; break
      case ' ': case 'Enter': {
        const filter = getDeckFilterControl(canvas)
        newVal = filter ? neutralFilterValue(filter.kind) : 0.5
        break
      }
      default: return
    }
    e.preventDefault()
    updateValue(newVal)
  })

  // Visual focus ring
  canvas.addEventListener('focus', () => { canvas.style.outline = '2px solid var(--red)'; canvas.style.outlineOffset = '2px' })
  canvas.addEventListener('blur',  () => { canvas.style.outline = 'none' })
}

// ── MAGIC AUDIO ───────────────────────────────────────────────────────────────
function drawMagicIdle(label = '[ GENERATE AUDIO FROM THE NEXT 4 BARS ]') {
  const ctx = magicWaveform.getContext('2d')!
  const W = magicWaveform.width, H = magicWaveform.height
  ctx.fillStyle = '#050000'; ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#1a0000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke()
  ctx.fillStyle = '#440000'; ctx.font = '12px Share Tech Mono'; ctx.textAlign = 'center'; ctx.fillText(label, W / 2, H / 2 + 4); ctx.textAlign = 'left'
}

function barsDurationSeconds(bars: number, bpm: number) {
  return bars * BEATS_PER_BAR * 60 / bpm
}

function setAudioCaptureStatus(state: 'idle' | 'connecting' | 'connected' | 'error', label: string) {
  audioCaptureDot.className = `dot ${state}`
  audioCaptureLabel.textContent = label
}

function isFirefox() {
  return navigator.userAgent.includes('Firefox/')
}

class LiveAudioCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveAudioCaptureError'
  }
}

function hasActiveLiveAudioShare() {
  return Boolean(
    liveAudioStream
    && liveAudioContext
    && liveAudioWorklet
    && liveAudioStream.getAudioTracks().some((track) => track.readyState === 'live'),
  )
}

function resetAudioCaptureAvailability() {
  if (isFirefox()) {
    btnAudioCapture.disabled = true
    setAudioCaptureStatus('error', 'FIREFOX CANNOT CAPTURE TAB AUDIO · USE CHROME OR EDGE')
    return
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    btnAudioCapture.disabled = true
    setAudioCaptureStatus('error', 'TAB AUDIO CAPTURE IS NOT SUPPORTED IN THIS BROWSER')
    return
  }

  btnAudioCapture.disabled = false
  setAudioCaptureStatus('idle', 'SHARE AUDIO NOW, OR GENERATE WILL ASK · RECORDING STARTS ON GENERATE')
}

function openAudiotoolProjectTab() {
  const projectUrl = inputProjectUrl.value.trim()
  if (!projectUrl) {
    setAudioCaptureStatus('error', 'PASTE AN AUDIOTOOL PROJECT URL FIRST')
    inputProjectUrl.focus()
    return
  }

  window.open(projectUrl, '_blank', 'noopener,noreferrer')
  if (!isFirefox()) {
    setAudioCaptureStatus('idle', 'RETURN HERE AND SHARE AUDIO, OR CLICK GENERATE TO CHOOSE THE PROJECT TAB')
  }
}

function requiredLiveAudioFrames(bpm: number) {
  const sampleRate = liveAudioContext?.sampleRate ?? CAPTURE_SAMPLE_RATE
  return Math.ceil(barsDurationSeconds(MAGIC_CAPTURE_BARS, bpm) * sampleRate)
}

function updateLiveAudioShareStatus() {
  if (!hasActiveLiveAudioShare() || activeLiveAudioRecording) return
  setAudioCaptureStatus('connected', 'AUDIO SHARING READY · THE NEXT 5 BARS RECORD WHEN YOU CLICK GENERATE')
}

function describeDisplayMediaError(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Tab sharing was cancelled or denied. Try again and select the Audiotool tab with Share tab audio enabled.'
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No shareable tab audio source was found. Open the Audiotool project in Chrome or Edge and try again.'
  }
  return error instanceof Error ? error.message : String(error)
}

function cancelActiveLiveAudioRecording(message: string) {
  const recording = activeLiveAudioRecording
  if (!recording) return

  activeLiveAudioRecording = null
  window.clearTimeout(recording.timeoutId)
  liveAudioWorklet?.port.postMessage({ type: 'stop' })
  recording.reject(new LiveAudioCaptureError(message))
}

function handleCaptureWorkletMessage(event: MessageEvent<CaptureWorkletMessage>) {
  const recording = activeLiveAudioRecording
  if (!recording) return

  const message = event.data
  if (message.recordingId !== recording.recordingId) return
  if (message.type === 'chunk') {
    const remainingFrames = recording.targetFrames - recording.capturedFrames
    const frameCount = Math.min(message.left.length, message.right.length, remainingFrames)
    if (frameCount <= 0) return
    recording.left.set(message.left.subarray(0, frameCount), recording.capturedFrames)
    recording.right.set(message.right.subarray(0, frameCount), recording.capturedFrames)
    recording.capturedFrames += frameCount
    const now = performance.now()
    if (now - recording.lastProgressUpdate >= 250 || recording.capturedFrames === recording.targetFrames) {
      recording.lastProgressUpdate = now
      setAudioCaptureStatus('connecting', 'LOADING…')
      setMagicStatus('generating', 'LOADING…')
    }
    return
  }

  if (recording.capturedFrames !== recording.targetFrames) {
    cancelActiveLiveAudioRecording('The tab-audio recording ended before five bars were captured. Keep Audiotool playing and try again.')
    return
  }

  activeLiveAudioRecording = null
  window.clearTimeout(recording.timeoutId)
  updateLiveAudioShareStatus()
  recording.resolve({ left: recording.left, right: recording.right })
}

async function recordNextFiveBars(bpm: number) {
  if (!hasActiveLiveAudioShare() || !liveAudioContext || !liveAudioWorklet) {
    throw new LiveAudioCaptureError('Share the Audiotool tab with audio before recording.')
  }
  if (activeLiveAudioRecording) {
    throw new LiveAudioCaptureError('A five-bar recording is already in progress.')
  }

  await liveAudioContext.resume()
  const targetFrames = requiredLiveAudioFrames(bpm)
  const timeoutMs = Math.ceil((targetFrames / liveAudioContext.sampleRate) * 1000) + 5000

  setAudioCaptureStatus('connecting', 'LOADING…')
  setMagicStatus('generating', 'LOADING…')
  return new Promise<CaptureChunk>((resolve, reject) => {
    const recordingId = ++liveAudioRecordingId
    const timeoutId = window.setTimeout(() => {
      const message = 'Five-bar recording timed out. Keep Audiotool playing in the shared tab and try again.'
      setAudioCaptureStatus('error', message.toUpperCase())
      cancelActiveLiveAudioRecording(message)
    }, timeoutMs)

    activeLiveAudioRecording = {
      recordingId,
      targetFrames,
      capturedFrames: 0,
      left: new Float32Array(targetFrames),
      right: new Float32Array(targetFrames),
      lastProgressUpdate: performance.now(),
      timeoutId,
      resolve,
      reject,
    }
    liveAudioWorklet!.port.postMessage({ type: 'start', recordingId, frameCount: targetFrames })
  })
}

async function stopLiveAudioCapture(status?: string) {
  liveAudioSessionId += 1
  cancelActiveLiveAudioRecording(status || 'Audio sharing stopped before the five-bar recording completed.')

  liveAudioWorklet?.disconnect()
  liveAudioSource?.disconnect()
  liveAudioSilentGain?.disconnect()
  liveAudioStream?.getTracks().forEach((track) => track.stop())
  if (liveAudioContext && liveAudioContext.state !== 'closed') await liveAudioContext.close()

  liveAudioStream = null
  liveAudioContext = null
  liveAudioSource = null
  liveAudioWorklet = null
  liveAudioSilentGain = null
  btnAudioCapture.textContent = '⬡ SHARE PROJECT AUDIO'
  if (status) {
    btnAudioCapture.disabled = false
    setAudioCaptureStatus('error', status)
  } else {
    resetAudioCaptureAvailability()
  }
}

async function startLiveAudioCapture() {
  if (hasActiveLiveAudioShare()) return
  if (liveAudioStream) await stopLiveAudioCapture()
  if (isFirefox()) {
    resetAudioCaptureAvailability()
    throw new LiveAudioCaptureError('Firefox cannot capture shared tab audio. Use Chrome or Edge.')
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    resetAudioCaptureAvailability()
    throw new LiveAudioCaptureError('Tab audio capture is not supported in this browser. Use Chrome or Edge.')
  }

  btnAudioCapture.disabled = true
  setAudioCaptureStatus('connecting', 'CHOOSE THE AUDIOTOOL TAB AND ENABLE SHARE TAB AUDIO…')
  const sessionId = ++liveAudioSessionId
  let pendingStream: MediaStream | null = null
  let pendingContext: AudioContext | null = null

  try {
    const options = {
      video: {
        displaySurface: 'browser',
        frameRate: { ideal: 1, max: 1 },
      },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        suppressLocalAudioPlayback: false,
      },
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
      systemAudio: 'exclude',
      windowAudio: 'exclude',
      monitorTypeSurfaces: 'exclude',
    } as DisplayMediaStreamOptions
    const stream = await navigator.mediaDevices.getDisplayMedia(options)
    pendingStream = stream
    if (sessionId !== liveAudioSessionId) {
      throw new LiveAudioCaptureError('Tab audio sharing was cancelled.')
    }

    const audioTrack = stream.getAudioTracks()[0]
    const videoTrack = stream.getVideoTracks()[0]
    if (!audioTrack) {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('No tab audio was shared. Select the Audiotool tab and enable Share tab audio.')
    }
    const displaySurface = videoTrack?.getSettings().displaySurface
    if (displaySurface && displaySurface !== 'browser') {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('Select the Audiotool browser tab, not a window or entire screen.')
    }

    const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE, latencyHint: 'interactive' })
    pendingContext = context
    await context.audioWorklet.addModule(new URL('./audio-capture-worklet.js', import.meta.url))
    const source = context.createMediaStreamSource(new MediaStream([audioTrack]))
    const worklet = new AudioWorkletNode(context, 'pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    worklet.port.onmessage = handleCaptureWorkletMessage
    const silentGain = context.createGain()
    silentGain.gain.value = 0
    source.connect(worklet).connect(silentGain).connect(context.destination)

    liveAudioStream = stream
    liveAudioContext = context
    liveAudioSource = source
    liveAudioWorklet = worklet
    liveAudioSilentGain = silentGain
    pendingStream = null
    pendingContext = null

    const handleEnded = () => {
      if (sessionId === liveAudioSessionId) void stopLiveAudioCapture('AUDIO SHARING STOPPED · SELECT THE AUDIOTOOL TAB AGAIN')
    }
    audioTrack.addEventListener('ended', handleEnded, { once: true })
    videoTrack?.addEventListener('ended', handleEnded, { once: true })
    btnAudioCapture.textContent = '✓ AUDIOTOOL AUDIO CONNECTED'
    updateLiveAudioShareStatus()
  } catch (error: unknown) {
    pendingStream?.getTracks().forEach((track) => track.stop())
    if (pendingContext && pendingContext.state !== 'closed') await pendingContext.close()
    if (sessionId !== liveAudioSessionId) {
      throw new LiveAudioCaptureError('Tab audio sharing was cancelled.')
    }
    const message = describeDisplayMediaError(error)
    await stopLiveAudioCapture(message)
    throw new LiveAudioCaptureError(message)
  }
}

function ensureLiveAudioCapture() {
  if (hasActiveLiveAudioShare()) return Promise.resolve()
  if (!liveAudioShareRequest) {
    liveAudioShareRequest = startLiveAudioCapture().finally(() => {
      liveAudioShareRequest = null
    })
  }
  return liveAudioShareRequest
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
}

function audioBufferToWav(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = buffer.length * blockAlign
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel))
  let offset = 44
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += bytesPerSample
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

function captureRms(chunk: CaptureChunk) {
  let sumSquares = 0
  for (let i = 0; i < chunk.left.length; i++) {
    sumSquares += (chunk.left[i] * chunk.left[i]) + (chunk.right[i] * chunk.right[i])
  }
  return Math.sqrt(sumSquares / Math.max(1, chunk.left.length * 2))
}

async function captureReferenceAudio(bpm: number): Promise<ReferenceAudio> {
  const chunk = await recordNextFiveBars(bpm)
  if (!liveAudioContext) {
    throw new LiveAudioCaptureError('Audiotool audio sharing stopped before the recording could be prepared.')
  }
  const requiredFrames = requiredLiveAudioFrames(bpm)
  if (captureRms(chunk) < 0.0001) {
    throw new LiveAudioCaptureError('The new five-bar recording is silent. Start playback in Audiotool, then click Generate again.')
  }

  const buffer = liveAudioContext.createBuffer(2, requiredFrames, liveAudioContext.sampleRate)
  buffer.copyToChannel(chunk.left, 0)
  buffer.copyToChannel(chunk.right, 1)
  return {
    blob: audioBufferToWav(buffer),
    fileName: `audiotool-live-${MAGIC_CAPTURE_BARS}-bars-${Math.round(bpm)}bpm.wav`,
    sourceLabel: 'AUDIOTOOL LIVE',
    seconds: buffer.duration,
  }
}

function magentaEndpoint() {
  return (magentaUrl.value.trim() || 'http://localhost:8000').replace(/\/+$/, '')
}

function getMagicGenerationBpm() {
  if (!currentProjectBpm || !Number.isFinite(currentProjectBpm)) {
    throw new Error('Project BPM required for beat-synced generation')
  }
  if (currentProjectBpm < MIN_SUPPORTED_BPM || currentProjectBpm > MAX_SUPPORTED_BPM) {
    throw new Error(`Project BPM must be between ${MIN_SUPPORTED_BPM} and ${MAX_SUPPORTED_BPM}`)
  }
  return currentProjectBpm
}

function describeMagentaError(error: unknown) {
  if (error instanceof TypeError) {
    return `Could not reach Magenta API at ${magentaEndpoint()}. Check that magenta_server.py is running on port 8000.`
  }
  return error instanceof Error ? error.message : 'Error'
}

// ── MAGENTA ───────────────────────────────────────────────────────────────────
function selectedMagicStemRole(): StemRole {
  const selected = magicStemRoleInputs.find((input) => input.checked)?.value
  if (selected === 'drums' || selected === 'bass' || selected === 'melody' || selected === 'texture') {
    return selected
  }
  return 'auto'
}

function setMagicStemRoleDisabled(disabled: boolean) {
  magicStemRoleInputs.forEach((input) => {
    input.disabled = disabled
  })
}

async function generateMagicAudio() {
  const promptText = magicPrompt.value.trim()
  if (!promptText) { setMagicStatus('error', 'PROMPT REQUIRED'); setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000); return }

  let generationBpm: number
  try {
    generationBpm = getMagicGenerationBpm()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    setMagicStatus('error', message.toUpperCase())
    setTimeout(() => setMagicStatus('idle', 'IDLE'), 4000)
    return
  }

  const stemRole = selectedMagicStemRole()
  const magicOperation = deckOperationStates[2]
  magicOperation.pendingCount += 1
  magicOperation.activeKind = 'generating'
  renderDeckTransport(2)
  setMagicStatus('generating', 'PREPARING AUDIO CAPTURE')
  btnGenerate.disabled = true
  setMagicStemRoleDisabled(true)
  try {
    await ensureLiveAudioCapture()
    const reference = await captureReferenceAudio(generationBpm)
    const form = new FormData()
    form.append('audio_file', reference.blob, reference.fileName)
    form.append('prompt', promptText)
    form.append('duration_bars', String(MAGIC_DURATION_BARS))
    form.append('bpm', String(generationBpm))
    form.append('stem_role', stemRole)
    form.append('avoid_clash', 'true')

    setMagicStatus('generating', `MAGENTA ← ${reference.sourceLabel}`)
    const resp = await fetch(`${magentaEndpoint()}/generate`, { method: 'POST', body: form })
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
    }
    const timingStatus = resp.headers.get('X-Magenta-Timing-Status') || 'aligned'
    const timingWarning = resp.headers.get('X-Magenta-Timing-Warning')
    const alignmentMs = resp.headers.get('X-Magenta-Alignment-Ms')
    console.info('[MAGENTA] timing', {
      status: timingStatus,
      warning: timingWarning,
      alignmentMs,
    })

    setMagicStatus('generating', 'LOADING WAV')
    const generatedBlob = await resp.blob()
    const generatedFile = new File([generatedBlob], `magic-${Date.now()}.wav`, { type: generatedBlob.type || 'audio/wav' })
    const magicDeck = decks[2]
    ensureCtx(magicDeck)
    const generatedBuffer = await magicDeck.audioCtx!.decodeAudioData(await generatedBlob.arrayBuffer())
    const inserted = await uploadToNexus(3, generatedFile, true, tempoSessionId, {
      timing: {
        bpm: generationBpm,
        musicDurationTicks: Ticks.Bars(MAGIC_DURATION_BARS),
      },
      sampleDescription: promptText,
    })
    if (!inserted) {
      setTimeout(() => setMagicStatus('idle', 'IDLE'), 5000)
      return
    }
    magicDeck.audioBuffer = generatedBuffer
    magicDeck.fileName = generatedFile.name
    magicWaveformPeaks = null
    drawMagicWaveform(generatedBuffer)
    renderDeckTransport(2)
    void initializeDeckCues(2, magicDeck.sampleMeta!)

    if (timingWarning || timingStatus !== 'aligned') {
      const warning = timingWarning || `Timing status: ${timingStatus}`
      setMagicStatus('warning', `⚠ ${warning.toUpperCase().slice(0, 72)}`)
      setTimeout(() => setMagicStatus('idle', 'IDLE'), 8000)
    } else {
      const alignmentLabel = alignmentMs ? ` · ${alignmentMs}ms` : ''
      setMagicStatus('done', `DONE ${Math.round(reference.seconds)}s REF${alignmentLabel}`)
      setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000)
    }
  } catch (e: unknown) {
    console.error('[MAGENTA] generate:', e)
    if (!decks[2].regionEntity) clearMagicDeckLocalMedia()
    const message = describeMagentaError(e)
    if (e instanceof LiveAudioCaptureError) {
      setAudioCaptureStatus('error', message.toUpperCase())
    }
    setMagicStatus('error', message.toUpperCase().slice(0, 48))
    setTimeout(() => setMagicStatus('idle', 'IDLE'), 4000)
  }
  finally {
    magicOperation.pendingCount = Math.max(0, magicOperation.pendingCount - 1)
    if (magicOperation.pendingCount === 0) magicOperation.activeKind = null
    renderDeckTransport(2)
    btnGenerate.disabled = false
    setMagicStemRoleDisabled(false)
  }
}

// ── DROP ZONES ────────────────────────────────────────────────────────────────
function setupDropZone(zoneId: string, deckIndex: 0 | 1) {
  const zone = document.getElementById(zoneId)!
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over') })
  zone.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', (e) => { e.stopPropagation(); if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove('drag-over') })
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over')
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    if (!file.name.match(/\.(mp3|wav)$/i)) { setStatus('error', 'ONLY MP3 / WAV FILES ACCEPTED'); return }
    setStatus('connecting', `${placementDeckLabel(deckIndex).toUpperCase()}: CAPTURING AUDIOTOOL BAR…`)
    try {
      const placement = await captureDeckInsertionPlacement(deckIndex)
      if (!placement) {
        setStatus('connected', `${placementDeckLabel(deckIndex).toUpperCase()}: LOAD CANCELLED — PROJECT CONTENT PRESERVED`)
        return
      }
      queueDeckLoad(deckIndex, file, placement)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus('error', `${placementDeckLabel(deckIndex).toUpperCase()}: LOAD FAILED — ${message}`)
    }
  })
}

function setupUnloadButton(deckIndex: 0 | 1) {
  el<HTMLButtonElement>(`deck${deckIndex + 1}-unload`).onclick = () => {
    queueDeckUnload(deckIndex)
  }
}

// ── TRANSPORT ─────────────────────────────────────────────────────────────────
function setupMagicWaveformSeek() {
  magicWaveform.title = 'Use Audiotool Studio timeline controls for playback and seeking'
  magicWaveform.addEventListener('click', (event) => {
    event.preventDefault()
    setStatus('connected', 'MAGIC WAVEFORM IS STATIC — USE AUDIOTOOL STUDIO FOR PLAYBACK AND SEEKING')
  })
}
function wireTransport(prefix: DeckPrefix, deckIndex: 0 | 1 | 2) {
  const deck = decks[deckIndex]
  const transport = getDeckTransportElements(deckIndex)
  const volSlider = document.getElementById(`${prefix}-vol`) as HTMLInputElement | null
  const volVal = document.getElementById(`${prefix}-vol-val`) as HTMLSpanElement | null
  const gainSlider = document.getElementById(`${prefix}-gain`) as HTMLInputElement | null
  const gainVal = document.getElementById(`${prefix}-gain-val`) as HTMLSpanElement | null

  const scheduleLaunch = (action: LaunchPositionAction) => {
    const outgoingValue = transport.crossfadeFrom.value
    if (outgoingValue === '') {
      queueDeckTransportOperation(
        deckIndex,
        'launching',
        (expectedSession) => mutateDeckLaunch(deckIndex, action, expectedSession),
      )
      return
    }
    const outgoingDeckIndex = Number(outgoingValue) as WaveformDeckIndex
    const fadeBars = Number(transport.crossfadeBars.value)
    queueDeckTransportOperation(
      deckIndex,
      'launching',
      (expectedSession) => mutateDeckCrossfade(
        deckIndex,
        outgoingDeckIndex,
        action,
        fadeBars,
        expectedSession,
      ),
      outgoingDeckIndex,
    )
  }

  const scheduleLaunchMovement = (direction: LaunchDirection) => {
    const stepValue = transport.step.value
    if (stepValue !== 'beat' && stepValue !== 'bar' && stepValue !== 'four-bars') return
    scheduleLaunch(composeLaunchPositionAction(direction, stepValue as LaunchStep))
  }

  transport.previous.addEventListener('click', () => scheduleLaunchMovement('previous'))
  transport.next.addEventListener('click', () => scheduleLaunchMovement('next'))
  transport.reenter.addEventListener('click', () => scheduleLaunch('reenter-bar'))
  transport.crossfadeFrom.addEventListener('change', () => renderDeckTransport(deckIndex))
  transport.cancel.addEventListener('click', () => {
    queueDeckTransportOperation(
      deckIndex,
      'cancelling',
      (expectedSession) => mutateDeckCancel(deckIndex, expectedSession),
    )
  })
  transport.stop.addEventListener('click', () => {
    queueDeckTransportOperation(
      deckIndex,
      'stopping',
      (expectedSession) => mutateDeckStop(deckIndex, expectedSession),
    )
  })

  volSlider?.addEventListener('input', () => {
    deck.volume = parseFloat(volSlider.value)
    if (volVal) volVal.textContent = String(Math.round(deck.volume * 100))
    void applyDeckProjectLevels(deckIndex, true)
  })

  gainSlider?.addEventListener('input', () => {
    deck.gainTrim = parseFloat(gainSlider.value)
    if (gainVal) gainVal.textContent = `${deck.gainTrim.toFixed(1)}x`
    void applyDeckProjectLevels(deckIndex)
  })

  if (deckIndex === 2) setupMagicWaveformSeek()
  renderDeckTransport(deckIndex)
}

// ── INIT ──────────────────────────────────────────────────────────────────────
function initApp() {
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())

  const saved = localStorage.getItem('nexus_project_url')
  if (saved) inputProjectUrl.value = saved
  inputProjectUrl.addEventListener('input', () => localStorage.setItem('nexus_project_url', inputProjectUrl.value))

  projectUrlRow.style.display = 'none'
  audioCaptureRow.style.display = 'none'
  resetBpmDialogue(0)
  resetBpmDialogue(1)
  setupManualBpmReport(0)
  setupManualBpmReport(1)
  setupTempoControls(0)
  setupTempoControls(1)
  setupTempoControls(2)
  btnConnect.onclick = () => connectProject()
  btnDisconnect.onclick = () => disconnectAll()
  btnOpenAudiotool.onclick = () => openAudiotoolProjectTab()
  btnAudioCapture.onclick = () => { void ensureLiveAudioCapture().catch(() => {}) }
  resetAudioCaptureAvailability()
  el<HTMLButtonElement>('btn-create-project').onclick = () => createNewProject()

  btnMusicLibraryChoose.onclick = () => {
    void (musicLibraryConnectionState === 'reconnect'
      ? reconnectMusicDirectory()
      : chooseMusicDirectory())
  }
  btnMusicLibraryRefresh.onclick = () => { void refreshMusicLibrary() }
  btnMusicLibraryChange.onclick = () => { void chooseMusicDirectory() }
  musicLibraryFallbackInput.addEventListener('change', () => {
    const files = Array.from(musicLibraryFallbackInput.files ?? [])
    if (files.length === 0) return
    const entries = indexMusicFiles(files)
    const relativePath = files[0].webkitRelativePath
    musicLibraryFolderName = relativePath.split('/').filter(Boolean)[0] || 'SELECTED FOLDER'
    musicLibraryDirectoryHandle = null
    updateMusicLibraryIndex(entries)
    musicLibraryUsesFallback = true
    setMusicLibrarySetupState(
      'ready',
      `${musicLibraryFolderName.toUpperCase()} · ${entries.length} ${entries.length === 1 ? 'TRACK' : 'TRACKS'} · SESSION ONLY`,
    )
  })
  setupDeckLibraryPicker(0)
  setupDeckLibraryPicker(1)
  renderMusicLibrarySetup()
  void restoreMusicLibrary()

  setupDropZone('drop-1', 0)
  setupDropZone('drop-2', 1)
  setupUnloadButton(0)
  setupUnloadButton(1)
  setupCueControls(0)
  setupCueControls(1)
  setupCueControls(2)
  updateSourceDeckUi(0)
  updateSourceDeckUi(1)
  wireTransport('d1', 0)
  wireTransport('d2', 1)
  wireTransport('d3', 2)
  document.querySelectorAll<HTMLCanvasElement>('.filter-knob, .eq-knob, .fx-knob').forEach(initKnob)
  document.querySelectorAll<HTMLButtonElement>('[data-deck-fx]').forEach((button) => {
    const deckIndex = Number(button.dataset.deckFx) as WaveformDeckIndex
    button.addEventListener('click', () => { void showDeckFxAssistant(deckIndex) })
  })
  const deckFxIndices = [0, 1, 2] as const
  deckFxIndices.forEach((deckIndex) => {
    getDeckFxElements(deckIndex).back.addEventListener('click', () => {
      if (activeFxDeckIndex === deckIndex) closeDeckFxAssistant()
    })
  })
  renderDeckFxAvailability()

  btnGenerate.addEventListener('click', generateMagicAudio)
  drawMagicIdle()

  init()
}

document.addEventListener('DOMContentLoaded', initApp)
