import { audiotool } from '@audiotool/nexus'
import { secondsToTicks, Ticks } from '@audiotool/nexus/utils'
import type { AuthenticatedClient, SyncedDocument } from '@audiotool/nexus'
import type { SampleMeta } from '@audiotool/nexus/api'
import type { NexusEntity, SafeTransactionBuilder } from '@audiotool/nexus/document'
import type { Terminable } from '@audiotool/nexus/utils'

// ── OAuth config ──────────────────────────────────────────────────────────────
const CLIENT_ID = 'fa370480-13d6-4cba-8015-f9297a81e9e8'
const REDIRECT_URL = 'http://127.0.0.1:5173/'
const SCOPE = 'project:write sample:write'

// ── Types ─────────────────────────────────────────────────────────────────────
interface DeckState {
  audioCtx: AudioContext | null; sourceNode: AudioBufferSourceNode | null
  gainNode: GainNode | null; audioBuffer: AudioBuffer | null
  isPlaying: boolean; isPaused: boolean; pauseOffset: number
  startedAt: number; looping: boolean; fileName: string | null
  baseBpm: number | null; pitchPercent: number; playbackRate: number
  volume: number; gainTrim: number
  sampleBpm: number | null; sampleMeta: SampleMeta | null
  regionEntity: NexusEntity<'audioRegion'> | null
  trackEntity: NexusEntity<'audioTrack'> | null; audioDeviceEntity: NexusEntity<'audioDevice'> | null
  mixerChannelEntity: NexusEntity<'mixerChannel'> | null; sampleEntity: NexusEntity<'sample'> | null
  automationCollectionEntity: NexusEntity<'automationCollection'> | null
  cableEntity: NexusEntity<'desktopAudioCable'> | null
  regionSubscriptions: Terminable[]
}
type DeckPrefix = 'd1' | 'd2' | 'd3'
type WaveformDeckIndex = 0 | 1 | 2
type EqBand = 'hi' | 'mid' | 'low'
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
interface AubioBpmResult {
  bpm: number | null
  confidence: number
  reliable: boolean
}
interface ManualBpmReportState {
  editing: boolean
  pending: boolean
  requestId: number
}
interface DeckOperationState {
  pendingCount: number
  activeKind: 'loading' | 'replacing' | 'unloading' | null
  suppressProjectRemovalSync: boolean
}
interface NativeTimingResult {
  durationTicks: number
  replacementRegion: NexusEntity<'audioRegion'> | null
}
interface SourceTimingReplacement {
  deckIndex: 0 | 1
  previousRegionId: string
  region: NexusEntity<'audioRegion'>
  automationCollection: NexusEntity<'automationCollection'>
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

// ── State ─────────────────────────────────────────────────────────────────────
let at: AuthenticatedClient | null = null
let nexus: SyncedDocument | null = null
let projectConnected = false
let currentProjectBpm: number | null = null
let tempoMasterEstablished = false
let deckLoadQueue: Promise<void> = Promise.resolve()
let sourceTimingQueue: Promise<void> = Promise.resolve()
let tempoSessionId = 0
let waveformAnimationFrame: number | null = null
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
const deckOperationStates: [DeckOperationState, DeckOperationState] = [
  { pendingCount: 0, activeKind: null, suppressProjectRemovalSync: false },
  { pendingCount: 0, activeKind: null, suppressProjectRemovalSync: false },
]
const guardedRegionRemovalIds = new Set<string>()

const decks: [DeckState, DeckState, DeckState] = [
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, volume: 0.8, gainTrim: 1, sampleBpm: null, sampleMeta: null, regionEntity: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null, sampleEntity: null, automationCollectionEntity: null, cableEntity: null, regionSubscriptions: [] },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, volume: 0.8, gainTrim: 1, sampleBpm: null, sampleMeta: null, regionEntity: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null, sampleEntity: null, automationCollectionEntity: null, cableEntity: null, regionSubscriptions: [] },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: true, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, volume: 0.8, gainTrim: 1, sampleBpm: null, sampleMeta: null, regionEntity: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null, sampleEntity: null, automationCollectionEntity: null, cableEntity: null, regionSubscriptions: [] },
]
const knobState: Map<HTMLCanvasElement, { value: number; dragging: boolean; startY: number; startVal: number }> = new Map()

// ── DOM ───────────────────────────────────────────────────────────────────────
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
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

// ── AUTH — based on the minimal example ──────────────────────────────────────
async function init() {
  setStatus('connecting', 'CHECKING AUTH STATE…')
  console.log('[INIT] Calling audiotool()…')

  try {
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
      if (window.location.search.includes('code=')) {
        window.history.replaceState({}, '', '/')
      }
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
  setStatus('connecting', 'OPENING PROJECT…')
  btnConnect.disabled = true
  resetTempoMasterSession()
  try {
    nexus = await at.open(projectUrl)
    nexus.connected.subscribe((connected) => {
      projectConnected = connected
      if (connected) {
        updateSourceDeckUi(0)
        updateSourceDeckUi(1)
      } else {
        resetManualBpmReport(0)
        resetManualBpmReport(1)
        updateSourceDeckUi(0)
        updateSourceDeckUi(1)
      }
      setStatus(connected ? 'connected' : 'error', connected ? 'SYNCED ↔ PROJECT ACTIVE' : 'CONNECTION LOST…')
    })
    loadBPM()
    await nexus.start()
    projectConnected = true
    updateSourceDeckUi(0)
    updateSourceDeckUi(1)
    setStatus('connected', 'SYNCED ↔ PROJECT ACTIVE')
    localStorage.setItem('nexus_project_url', projectUrl)
  } catch (e: unknown) {
    setStatus('error', `PROJECT ERROR: ${e instanceof Error ? e.message : String(e)}`)
    nexus = null
    projectConnected = false
    btnConnect.disabled = false
  }
}

function resetTempoMasterSession() {
  tempoSessionId += 1
  projectConnected = false
  tempoMasterEstablished = false
  currentProjectBpm = null
  pendingBpmResolutions.forEach((resolve, deckIndex) => {
    resolve?.(null)
    pendingBpmResolutions[deckIndex] = null
    resetBpmDialogue(deckIndex)
  })
  resetManualBpmReport(0)
  resetManualBpmReport(1)
}

// ── NEXUS ─────────────────────────────────────────────────────────────────────
function updateDeckBpmLabels(bpm: number | null) {
  const normalizedBpm = normalizeBpm(bpm)
  currentProjectBpm = normalizedBpm
  decks.forEach((deck, index) => {
    if (deck.sampleBpm === null) deck.baseBpm = normalizedBpm
    updateDeckBpmLabel(index as WaveformDeckIndex)
  })
  updateLiveAudioShareStatus()
}
function updateDeckBpmLabel(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  if (deckIndex < 2 && !isSourceDeckSynchronized(deckIndex as 0 | 1)) {
    el(`deck${deckIndex + 1}-bpm`).textContent = '—'
    return
  }
  const bpm = normalizeBpm(deck.sampleBpm ?? deck.baseBpm)
  el(`deck${deckIndex + 1}-bpm`).textContent = bpm === null ? '—' : String(bpm)
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
  void serializeSourceTiming(async () => {
    if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
    try {
      const applied = await remapLoadedSourceRegions(
        projectDocument,
        projectBpm,
        expectedSession,
      )
      if (!applied) return
      if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
      updateDeckBpmLabels(projectBpm)
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
      scheduleProjectTempoRemap(projectDocument, nextBpm, expectedSession)
    }, true)
  })
}

function clearDeckProjectEntities(deck: DeckState) {
  deck.regionSubscriptions.forEach((subscription) => subscription.terminate())
  deck.regionSubscriptions = []
  deck.sampleBpm = null
  deck.sampleMeta = null
  deck.regionEntity = null
  deck.trackEntity = null
  deck.audioDeviceEntity = null
  deck.mixerChannelEntity = null
  deck.sampleEntity = null
  deck.automationCollectionEntity = null
  deck.cableEntity = null
  const deckIndex = decks.indexOf(deck)
  if (deckIndex === 0 || deckIndex === 1) {
    resetManualBpmReport(deckIndex)
  }
}

function isSourceDeckSynchronized(deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  return deck.audioBuffer !== null
    && deck.fileName !== null
    && deck.regionEntity !== null
    && deck.trackEntity !== null
    && deck.audioDeviceEntity !== null
    && deck.mixerChannelEntity !== null
    && deck.sampleEntity !== null
    && deck.automationCollectionEntity !== null
    && deck.cableEntity !== null
}

function clearWaveformCanvas(deckIndex: 0 | 1) {
  const canvas = el<HTMLCanvasElement>(`waveform-${deckIndex + 1}`)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function updateSourceDeckUi(deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  const operation = deckOperationStates[deckIndex]
  const loaded = isSourceDeckSynchronized(deckIndex)
  const pending = operation.pendingCount > 0
  const zone = el<HTMLDivElement>(`drop-${deckIndex + 1}`)
  const filename = el<HTMLDivElement>(`drop${deckIndex + 1}-filename`)
  const unload = el<HTMLButtonElement>(`deck${deckIndex + 1}-unload`)

  zone.classList.toggle('loaded', loaded)
  zone.classList.toggle('pending', pending)
  zone.setAttribute('aria-busy', String(pending))
  filename.textContent = loaded ? deck.fileName ?? '' : ''
  unload.classList.toggle('is-hidden', !loaded)
  unload.disabled = pending || !projectConnected
  updateDeckBpmLabel(deckIndex)

  if (loaded && deck.audioBuffer) {
    redrawDeckWaveform(deckIndex)
  } else {
    clearWaveformCanvas(deckIndex)
  }
  updateManualBpmReportUi(deckIndex)
}

function clearSourceDeckLocalMedia(deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  deckStop(deck)
  deck.audioBuffer = null
  deck.fileName = null
  deck.baseBpm = null
  deck.playbackRate = 1
  clearWaveformCanvas(deckIndex)
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
    && deckOperationStates[deckIndex].pendingCount === 0
    && isSourceDeckSynchronized(deckIndex)
}

function updateManualBpmReportUi(deckIndex: 0 | 1) {
  const state = manualBpmReportStates[deckIndex]
  const controls = getManualBpmReportElements(deckIndex)
  const available = canReportManualBpm(deckIndex)
  controls.trigger.classList.toggle('is-hidden', !available || state.editing)
  controls.form.classList.toggle('is-hidden', !available || !state.editing)
  controls.trigger.disabled = state.pending
  controls.input.disabled = state.pending
  controls.apply.disabled = state.pending
  controls.cancel.disabled = state.pending
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
  t: SafeTransactionBuilder,
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
  if (regionUsers.length !== 1 || regionUsers[0].id !== region.id) return null
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

function replaceSourceRegionWithNativeTiming(
  t: SafeTransactionBuilder,
  region: NexusEntity<'audioRegion'>,
  durationTicks: number,
  guardedIds: string[],
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
      durationTicks,
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
    timestretchMode: 1,
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
): NativeTimingResult {
  const durationTicks = secondsToTicks(sampleDurationSeconds, projectBpm)
  if (!Number.isFinite(durationTicks) || durationTicks <= 0) {
    throw new Error('The source duration could not be converted to project ticks')
  }

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

  t.update(region.fields.region.fields.durationTicks, durationTicks)
  t.update(region.fields.region.fields.loopDurationTicks, durationTicks)
  t.update(terminalEvent.fields.positionTicks, durationTicks)
  t.update(region.fields.timestretchMode, 1)
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
    deck.regionSubscriptions.forEach((subscription) => subscription.terminate())
    deck.regionSubscriptions = []
    deck.regionEntity = replacement.region
    deck.automationCollectionEntity = replacement.automationCollection
    watchDeckProjectEntities(
      replacement.deckIndex,
      projectDocument,
      replacement.region,
      deck.trackEntity,
      expectedSession,
    )
    updateSourceDeckUi(replacement.deckIndex)
  })
}

function updateMagicLoopDurationInTransaction(
  t: SafeTransactionBuilder,
  durationOverrides?: ReadonlyMap<string, number>,
) {
  const magicRegionId = decks[2].regionEntity?.id
  if (!magicRegionId) return
  const magicRegion = t.entities.ofTypes('audioRegion').getEntity(magicRegionId)
  if (!magicRegion) return
  const durationTicks = getMagicLoopDurationTicks(t, durationOverrides)
  if (magicRegion.fields.region.fields.durationTicks.value !== durationTicks) {
    t.update(magicRegion.fields.region.fields.durationTicks, durationTicks)
  }
}

async function remapLoadedSourceRegions(
  projectDocument: SyncedDocument,
  projectBpm: number,
  expectedSession: number,
) {
  const sources = decks.slice(0, 2).flatMap((deck, deckIndex) =>
    deck.regionEntity && deck.sampleMeta
      ? [{
          deckIndex: deckIndex as 0 | 1,
          regionId: deck.regionEntity.id,
          sampleDurationSeconds: deck.sampleMeta.durationSeconds,
        }]
      : [],
  )
  const guardedIds: string[] = []
  try {
    const transactionResult = await projectDocument.modify((t) => {
      const config = t.entities.ofTypes('config').get()[0]
      const currentTempo = Number(config?.fields.tempoBpm.value)
      if (!Number.isFinite(currentTempo) || Math.abs(currentTempo - projectBpm) > 0.0001) {
        return { applied: false, replacements: [] as SourceTimingReplacement[] }
      }
      const nextReplacements: SourceTimingReplacement[] = []
      const durationOverrides = new Map<string, number>()
      sources.forEach((source) => {
        const region = t.entities.ofTypes('audioRegion').getEntity(source.regionId)
        if (!region) throw new Error(`Deck ${source.deckIndex + 1} project region was not found`)
        const result = applyNativeSourceTiming(
          t,
          region,
          source.sampleDurationSeconds,
          projectBpm,
          guardedIds,
        )
        durationOverrides.set(source.regionId, result.durationTicks)
        if (result.replacementRegion) {
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
      updateMagicLoopDurationInTransaction(t, durationOverrides)
      return { applied: true, replacements: nextReplacements }
    })
    if (!transactionResult.applied) return false
    if (nexus !== projectDocument || expectedSession !== tempoSessionId) {
      throw new Error('The project connection changed during the tempo remap')
    }
    rebindSourceTimingReplacements(
      transactionResult.replacements,
      projectDocument,
      expectedSession,
    )
    return true
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

        const timingResult = applyNativeSourceTiming(
          t,
          region,
          sampleDurationSeconds,
          effectiveProjectBpm,
          guardedIds,
        )
        const replacements: SourceTimingReplacement[] = []
        if (timingResult.replacementRegion) {
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
        updateMagicLoopDurationInTransaction(
          t,
          new Map([[regionId, timingResult.durationTicks]]),
        )
        return { projectTempoUpdated, replacements }
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
      if (transactionResult.projectTempoUpdated) {
        updateDeckBpmLabels(correctedBpm)
      } else {
        updateDeckBpmLabel(deckIndex)
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
  const prefix = `deck${deckNum}-bpm`
  el<HTMLDivElement>(`${prefix}-dialogue`).classList.remove('is-hidden')
  el<HTMLDivElement>(`${prefix}-form`).classList.add('is-hidden')
  const title = el<HTMLDivElement>(`${prefix}-title`)
  title.textContent = 'ANALYZING BPM…'
  title.classList.remove('bpm-dialogue-title-idle')
}

function showBpmDialogue(deckNum: number, estimate?: AubioBpmResult): Promise<BpmResolution | null> {
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

async function uploadSample(file: File, displayName: string, bpm?: number) {
  if (!at) throw new Error('Not logged in')
  const upload = await at.samples.upload({ file, displayName, kind: 'loop', bpm })
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

  const cable = t.entities
    .ofTypes('desktopAudioCable')
    .get()
    .find((candidate) => candidate.fields.fromSocket.value.equals(audioDevice.fields.audioOutput.location))
  if (!cable) throw new Error('Inserted mixer cable was not found')

  const mixerChannel = t.entities.ofTypes('mixerChannel').getEntity(cable.fields.toSocket.value.entityId)
  if (!mixerChannel) throw new Error('Inserted mixer channel was not found')

  return { track, audioDevice, mixerChannel, sample, automationCollection, cable }
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
    return region
      ? Math.max(durationTicks, region.fields.region.fields.durationTicks.value)
      : durationTicks
  }, Ticks.Bars(MAGIC_DURATION_BARS))
}

async function syncMagicLoopDuration(projectDocument: SyncedDocument, expectedSession: number) {
  if (nexus !== projectDocument || expectedSession !== tempoSessionId) return
  await projectDocument.modify((t) => {
    const magicRegionId = decks[2].regionEntity?.id
    if (!magicRegionId) return
    const magicRegion = t.entities.ofTypes('audioRegion').getEntity(magicRegionId)
    if (!magicRegion) return
    const durationTicks = getMagicLoopDurationTicks(t)
    if (magicRegion.fields.region.fields.durationTicks.value !== durationTicks) {
      t.update(magicRegion.fields.region.fields.durationTicks, durationTicks)
    }
  })
}

function handleExternalDeckEntityRemoval(
  deckIndex: 0 | 1,
  projectDocument: SyncedDocument,
  expectedSession: number,
  removedEntity: 'region' | 'track',
) {
  const operation = deckOperationStates[deckIndex]
  if (
    operation.suppressProjectRemovalSync
    || (removedEntity === 'region' && guardedRegionRemovalIds.has(decks[deckIndex].regionEntity?.id ?? ''))
  ) return
  const reportWasActive = manualBpmReportStates[deckIndex].editing
  clearSourceDeckLocalMedia(deckIndex)
  clearDeckProjectEntities(decks[deckIndex])
  updateSourceDeckUi(deckIndex)
  void syncMagicLoopDuration(projectDocument, expectedSession)
  if (reportWasActive) {
    setStatus('error', `DECK ${deckIndex + 1}: BPM REPORT CANCELLED — PROJECT ${removedEntity.toUpperCase()} WAS REMOVED`)
  } else {
    setStatus('connected', `DECK ${deckIndex + 1}: PROJECT ${removedEntity.toUpperCase()} REMOVED — LOCAL DECK CLEARED`)
  }
}

function watchDeckProjectEntities(
  deckIndex: 0 | 1,
  projectDocument: SyncedDocument,
  region: NexusEntity<'audioRegion'>,
  track: NexusEntity<'audioTrack'>,
  expectedSession: number,
) {
  const deck = decks[deckIndex]
  deck.regionSubscriptions.push(
    projectDocument.events.onUpdate(region.fields.region.fields.durationTicks, () => {
      if (deck.regionEntity?.id === region.id) {
        void syncMagicLoopDuration(projectDocument, expectedSession)
      }
    }),
    projectDocument.events.onRemove(region, () => {
      if (deck.regionEntity?.id !== region.id) return
      handleExternalDeckEntityRemoval(deckIndex, projectDocument, expectedSession, 'region')
    }),
    projectDocument.events.onRemove(track, () => {
      if (deck.trackEntity?.id !== track.id) return
      handleExternalDeckEntityRemoval(deckIndex, projectDocument, expectedSession, 'track')
    }),
  )
}

async function insertSampleIntoProject(
  deckNum: number,
  sample: SampleMeta,
  displayName: string,
  forceMagicLoop: boolean,
  resolution?: BpmResolution,
  expectedSession = tempoSessionId,
  timing?: SampleTiming,
) {
  if (!nexus) throw new Error('Project not connected')
  const projectDocument = nexus
  const deck = decks[deckNum - 1]
  const sampleBpm = normalizeBpm(sample.bpm)
  const bpm = normalizeBpm(timing?.bpm ?? resolution?.bpm ?? (isSupportedBpm(sampleBpm) ? sampleBpm : currentProjectBpm))
  if (!isSupportedBpm(bpm)) throw new Error(`A BPM between ${MIN_SUPPORTED_BPM} and ${MAX_SUPPORTED_BPM} is required`)
  const establishesMaster = deckNum <= 2 && !tempoMasterEstablished

  const insertTransaction = () => projectDocument.modify((t) => {
    const config = t.entities.ofTypes('config').get()[0]
    const isSourceDeck = deckNum <= 2
    if (isSourceDeck && !config) throw new Error('Project tempo configuration was not found')
    const effectiveProjectBpm = establishesMaster
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
    if (establishesMaster && config) {
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
        ? { positionTicks: 0, durationTicks: getMagicLoopDurationTicks(t) }
        : { positionTicks: 0 },
      loop: forceMagicLoop ? true : undefined,
      displayName,
    })
    if (isSourceDeck) {
      t.update(region.fields.timestretchMode, 1)
    } else if (forceMagicLoop) {
      t.update(region.fields.timestretchMode, 2)
    }
    const entities = resolveInsertedProjectEntities(region, t)
    return { region, ...entities }
  })
  const inserted = deckNum <= 2
    ? await serializeSourceTiming(insertTransaction)
    : await insertTransaction()
  if (expectedSession !== tempoSessionId || nexus !== projectDocument) {
    throw new Error('Project connection changed during insertion')
  }

  if (establishesMaster) {
    tempoMasterEstablished = true
    currentProjectBpm = bpm
  }

  deck.sampleBpm = bpm
  deck.baseBpm = bpm
  deck.sampleMeta = deckNum <= 2 ? sample : null
  deck.regionEntity = inserted.region
  deck.trackEntity = inserted.track
  deck.audioDeviceEntity = inserted.audioDevice
  deck.mixerChannelEntity = inserted.mixerChannel
  deck.sampleEntity = inserted.sample
  deck.automationCollectionEntity = inserted.automationCollection
  deck.cableEntity = inserted.cable
  if (deckNum <= 2) {
    watchDeckProjectEntities(
      (deckNum - 1) as 0 | 1,
      projectDocument,
      inserted.region,
      inserted.track,
      expectedSession,
    )
    updateManualBpmReportUi((deckNum - 1) as 0 | 1)
    try {
      await syncMagicLoopDuration(projectDocument, expectedSession)
    } catch (error) {
      console.warn('[NEXUS] magic loop resize after source insertion:', error)
    }
  }
  updateDeckBpmLabel((deckNum - 1) as WaveformDeckIndex)
  applyCurrentDeckEq((deckNum - 1) as WaveformDeckIndex)
  void applyCurrentDeckLevels((deckNum - 1) as WaveformDeckIndex)
  return inserted
}

async function uploadToNexus(
  deckNum: number,
  file: File,
  forceMagicLoop = false,
  expectedSession = tempoSessionId,
  timing?: SampleTiming,
) {
  if (!nexus || !at) throw new Error('Connect an Audiotool project before loading audio')
  setStatus('connected', `UPLOADING ${file.name}…`)
  try {
    const displayName = `${deckNum === 3 ? 'MAGIC DECK' : `DECK ${deckNum}`} — ${file.name}`
    const sample = await uploadSample(file, displayName, timing?.bpm)
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
    setStatus('connected', `DECK ${deckNum}: SAMPLE READY — INSERTING PROJECT REGION…`)
    const selectingMaster = deckNum <= 2 && !tempoMasterEstablished
    await insertSampleIntoProject(
      deckNum,
      sample,
      displayName,
      forceMagicLoop,
      resolution ?? undefined,
      expectedSession,
      timing,
    )
    if (deckNum <= 2) {
      setStatus('connected', selectingMaster
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

async function removeDeckProjectGraph(deckIndex: 0 | 1, expectedSession: number) {
  const deck = decks[deckIndex]
  const operation = deckOperationStates[deckIndex]
  const projectDocument = nexus
  if (!projectDocument || !projectConnected || expectedSession !== tempoSessionId) {
    throw new Error('Project is not connected')
  }

  const regionId = deck.regionEntity?.id
  const trackId = deck.trackEntity?.id
  const audioDeviceId = deck.audioDeviceEntity?.id
  const mixerChannelId = deck.mixerChannelEntity?.id
  const cableId = deck.cableEntity?.id
  const storedSampleId = deck.sampleEntity?.id
  const storedAutomationCollectionId = deck.automationCollectionEntity?.id
  if (!regionId && !trackId && !audioDeviceId && !mixerChannelId) {
    throw new Error('The synchronized project graph is no longer available')
  }

  operation.suppressProjectRemovalSync = true
  try {
    await serializeSourceTiming(() => projectDocument.modify((t) => {
      const region = regionId
        ? t.entities.ofTypes('audioRegion').getEntity(regionId)
        : undefined
      const sampleId = region?.fields.sample.value.entityId ?? storedSampleId
      const automationCollectionId = region?.fields.playbackAutomationCollection.value.entityId
        ?? storedAutomationCollectionId
      const track = trackId
        ? t.entities.ofTypes('audioTrack').getEntity(trackId)
        : undefined
      const resolvedAudioDeviceId = track?.fields.player.value.entityId ?? audioDeviceId
      const audioDevice = resolvedAudioDeviceId
        ? t.entities.ofTypes('audioDevice').getEntity(resolvedAudioDeviceId)
        : undefined

      if (audioDevice) {
        t.removeWithDependencies(audioDevice)
      } else if (track) {
        t.removeWithDependencies(track)
      } else if (region) {
        t.remove(region)
      }

      const mixerChannel = mixerChannelId
        ? t.entities.ofTypes('mixerChannel').getEntity(mixerChannelId)
        : undefined
      if (mixerChannel) t.removeWithDependencies(mixerChannel)

      const cable = cableId
        ? t.entities.ofTypes('desktopAudioCable').getEntity(cableId)
        : undefined
      if (cable) t.remove(cable)

      const sample = sampleId
        ? t.entities.ofTypes('sample').getEntity(sampleId)
        : undefined
      if (sample) t.removeWithDependencies(sample)

      const automationCollection = automationCollectionId
        ? t.entities.ofTypes('automationCollection').getEntity(automationCollectionId)
        : undefined
      if (automationCollection) t.removeWithDependencies(automationCollection)
    }))
    clearDeckProjectEntities(deck)
  } finally {
    operation.suppressProjectRemovalSync = false
  }

  try {
    await syncMagicLoopDuration(projectDocument, expectedSession)
  } catch (error) {
    console.warn('[NEXUS] magic loop resize after deck removal:', error)
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

async function applyDeckProjectLevels(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  if (!nexus || !deck.mixerChannelEntity) {
    setStatus('connected', `DECK ${deckIndex + 1}: LOAD AUDIO TO ENABLE PROJECT LEVELS`)
    return
  }

  try {
    await nexus.modify((t) => {
      const channel = t.entities.ofTypes('mixerChannel').getEntity(deck.mixerChannelEntity!.id) ?? deck.mixerChannelEntity!
      t.update(channel.fields.faderParameters.fields.postGain, deck.volume)
      t.update(channel.fields.preGain, PROJECT_PRE_GAIN_BASE * deck.gainTrim)
    })
  } catch (e) {
    console.warn('[NEXUS] level update:', e)
    setStatus('error', `LEVEL UPDATE FAILED: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function applyCurrentDeckLevels(deckIndex: WaveformDeckIndex) {
  applyDeckPreviewGain(decks[deckIndex])
  return applyDeckProjectLevels(deckIndex)
}

// ── AUDIO ─────────────────────────────────────────────────────────────────────
function applyDeckPreviewGain(deck: DeckState) {
  if (deck.gainNode) deck.gainNode.gain.value = deck.volume * deck.gainTrim
}

function ensureCtx(deck: DeckState) {
  if (!deck.audioCtx) {
    deck.audioCtx = new AudioContext(); deck.gainNode = deck.audioCtx.createGain()
    deck.gainNode.connect(deck.audioCtx.destination)
    applyDeckPreviewGain(deck)
  }
}
function formatPitch(value: number) {
  const rounded = Number(value.toFixed(1))
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}%`
}
function normalizeDeckOffset(deck: DeckState, offset: number) {
  if (!deck.audioBuffer || deck.audioBuffer.duration <= 0) return 0
  if (deck.looping) return ((offset % deck.audioBuffer.duration) + deck.audioBuffer.duration) % deck.audioBuffer.duration
  return Math.max(0, Math.min(offset, Math.max(0, deck.audioBuffer.duration - 0.001)))
}
function deckStop(deck: DeckState) {
  const source = deck.sourceNode
  deck.sourceNode = null
  deck.isPlaying = false; deck.isPaused = false; deck.pauseOffset = 0
  source?.stop()
  redrawDeckWaveformByState(deck)
}
async function loadAudioFile(deckIndex: 0 | 1, file: File, expectedSession: number) {
  const deck = decks[deckIndex]
  const operation = deckOperationStates[deckIndex]
  const replacing = isSourceDeckSynchronized(deckIndex)
  operation.activeKind = replacing ? 'replacing' : 'loading'
  updateSourceDeckUi(deckIndex)
  ensureCtx(deck)

  setStatus('connecting', `DECK ${deckIndex + 1}: ${replacing ? 'PREPARING REPLACEMENT' : 'DECODING AUDIO'}…`)
  const buffer = await deck.audioCtx!.decodeAudioData(await file.arrayBuffer())
  if (expectedSession !== tempoSessionId) throw new Error('Project connection changed during audio decoding')

  if (replacing) {
    setStatus('connecting', `DECK ${deckIndex + 1}: REMOVING OLD PROJECT TRACK BEFORE REPLACEMENT…`)
    await removeDeckProjectGraph(deckIndex, expectedSession)
    clearSourceDeckLocalMedia(deckIndex)
    updateSourceDeckUi(deckIndex)
  }

  const inserted = await uploadToNexus(deckIndex + 1, file, false, expectedSession)
  if (!inserted) {
    updateSourceDeckUi(deckIndex)
    return
  }
  if (expectedSession !== tempoSessionId) throw new Error('Project connection changed after insertion')

  deck.audioBuffer = buffer
  deck.fileName = file.name
  updateSourceDeckUi(deckIndex)
}

function queueDeckLoad(deckIndex: 0 | 1, file: File) {
  const operation = deckOperationStates[deckIndex]
  const expectedSession = tempoSessionId
  operation.pendingCount += 1
  updateSourceDeckUi(deckIndex)
  deckLoadQueue = deckLoadQueue
    .then(async () => {
      if (expectedSession !== tempoSessionId) return
      await loadAudioFile(deckIndex, file, expectedSession)
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
  setStatus('connecting', `DECK ${deckIndex + 1}: UNLOADING — REMOVING PROJECT TRACK GRAPH…`)
  await removeDeckProjectGraph(deckIndex, expectedSession)
  clearSourceDeckLocalMedia(deckIndex)
  updateSourceDeckUi(deckIndex)
  setStatus('connected', `DECK ${deckIndex + 1}: UNLOADED — PROJECT GRAPH REMOVED ✓`)
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
function getWaveformCanvas(deckIndex: WaveformDeckIndex) {
  return el<HTMLCanvasElement>(deckIndex === 2 ? 'magic-waveform' : `waveform-${deckIndex + 1}`)
}

function getDeckIndex(deck: DeckState): WaveformDeckIndex | null {
  const index = decks.indexOf(deck)
  return index === -1 ? null : index as WaveformDeckIndex
}

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

function drawWaveformPlayhead(canvas: HTMLCanvasElement, deck: DeckState) {
  if (!deck.audioBuffer || deck.audioBuffer.duration <= 0) return
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height
  const ratio = getDeckPositionSeconds(deck) / deck.audioBuffer.duration
  const x = Math.max(0, Math.min(W - 1, ratio * W))
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(Math.round(x) + 0.5, 0)
  ctx.lineTo(Math.round(x) + 0.5, H)
  ctx.stroke()
}

function redrawDeckWaveform(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  if (!deck.audioBuffer) return
  const canvas = getWaveformCanvas(deckIndex)
  drawWaveformBase(canvas, deck.audioBuffer)
  drawWaveformPlayhead(canvas, deck)
}

function redrawDeckWaveformByState(deck: DeckState) {
  const deckIndex = getDeckIndex(deck)
  if (deckIndex === null) return
  redrawDeckWaveform(deckIndex)
}

function anyWaveformLoaded() {
  return decks.some((deck) => deck.audioBuffer && deck.isPlaying)
}

function scheduleWaveformRendering() {
  if (waveformAnimationFrame !== null || !anyWaveformLoaded()) return

  const tick = () => {
    ([0, 1, 2] as WaveformDeckIndex[]).forEach(redrawDeckWaveform)
    waveformAnimationFrame = anyWaveformLoaded() ? requestAnimationFrame(tick) : null
  }

  waveformAnimationFrame = requestAnimationFrame(tick)
}

function drawWaveform(id: string, buf: AudioBuffer) {
  drawWaveformBase(el<HTMLCanvasElement>(id), buf)
  scheduleWaveformRendering()
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

  const updateValue = (newValue: number) => {
    const s = knobState.get(canvas)!
    s.value = Math.max(0, Math.min(1, newValue))
    drawKnob(canvas, s.value)
    canvas.setAttribute('aria-valuenow', String(Math.round(s.value * 100)))
    const control = getDeckEqControl?.(canvas)
    if (control) void applyDeckEq?.(control.deckIndex, control.band, s.value)
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
      case ' ': case 'Enter': newVal = 0.5; break  // Space/Enter centers the knob
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

function getDeckPositionSeconds(deck: DeckState) {
  if (!deck.audioBuffer) return 0
  if (deck.isPlaying && deck.audioCtx) {
    const elapsed = deck.pauseOffset + ((deck.audioCtx.currentTime - deck.startedAt) * deck.playbackRate)
    if (deck.looping && deck.audioBuffer.duration > 0) return normalizeDeckOffset(deck, elapsed)
    return Math.max(0, Math.min(elapsed, deck.audioBuffer.duration))
  }
  return Math.max(0, Math.min(deck.pauseOffset, deck.audioBuffer.duration))
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
      const progress = Math.min(1, recording.capturedFrames / recording.targetFrames)
      const barsRecorded = (progress * MAGIC_CAPTURE_BARS).toFixed(1)
      setAudioCaptureStatus('connecting', `RECORDING NEW AUDIO · ${barsRecorded} / ${MAGIC_CAPTURE_BARS} BARS`)
      setMagicStatus('generating', `RECORDING ${barsRecorded} / ${MAGIC_CAPTURE_BARS} BARS`)
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

  setAudioCaptureStatus('connecting', `RECORDING NEW AUDIO · 0.0 / ${MAGIC_CAPTURE_BARS} BARS`)
  setMagicStatus('generating', `RECORDING 0.0 / ${MAGIC_CAPTURE_BARS} BARS`)
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
    deckStop(magicDeck)
    clearDeckProjectEntities(magicDeck)
    magicDeck.looping = true
    magicDeck.audioBuffer = generatedBuffer
    magicDeck.fileName = generatedFile.name
    applyDeckPreviewGain(magicDeck)
    drawWaveform('magic-waveform', generatedBuffer)
    syncTransportUi('d3', magicDeck)
    await uploadToNexus(3, generatedFile, true, tempoSessionId, {
      bpm: generationBpm,
      musicDurationTicks: Ticks.Bars(MAGIC_DURATION_BARS),
    })

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
    const message = describeMagentaError(e)
    if (e instanceof LiveAudioCaptureError) {
      setAudioCaptureStatus('error', message.toUpperCase())
    }
    setMagicStatus('error', message.toUpperCase().slice(0, 48))
    setTimeout(() => setMagicStatus('idle', 'IDLE'), 4000)
  }
  finally {
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
    queueDeckLoad(deckIndex, file)
  })
}

function setupUnloadButton(deckIndex: 0 | 1) {
  el<HTMLButtonElement>(`deck${deckIndex + 1}-unload`).onclick = () => {
    queueDeckUnload(deckIndex)
  }
}

// ── TRANSPORT ─────────────────────────────────────────────────────────────────
function syncTransportUi(prefix: DeckPrefix, deck: DeckState) {
  document.getElementById(`${prefix}-play`)?.classList.toggle('active', deck.isPlaying)
  document.getElementById(`${prefix}-pause`)?.classList.toggle('active', deck.isPaused)
  document.getElementById(`${prefix}-loop`)?.classList.toggle('active', deck.looping)
  const pitchValue = document.getElementById(`${prefix}-pitch`)
  if (pitchValue) pitchValue.textContent = formatPitch(deck.pitchPercent)
}
function setupWaveformSeek(prefix: DeckPrefix, deckIndex: WaveformDeckIndex) {
  const canvas = getWaveformCanvas(deckIndex)
  canvas.title = 'Use Audiotool Studio timeline controls for playback and seeking'
  canvas.addEventListener('click', (event) => {
    event.preventDefault()
    setStatus('connected', ``)
  })
}
function wireTransport(prefix: DeckPrefix, deckIndex: 0 | 1 | 2) {
  const deck = decks[deckIndex]
  const playBtn = document.getElementById(`${prefix}-play`) as HTMLButtonElement | null
  const pauseBtn = document.getElementById(`${prefix}-pause`) as HTMLButtonElement | null
  const stopBtn = document.getElementById(`${prefix}-stop`) as HTMLButtonElement | null
  const loopBtn = document.getElementById(`${prefix}-loop`) as HTMLButtonElement | null
  const volSlider = document.getElementById(`${prefix}-vol`) as HTMLInputElement | null
  const volVal = document.getElementById(`${prefix}-vol-val`) as HTMLSpanElement | null
  const gainSlider = document.getElementById(`${prefix}-gain`) as HTMLInputElement | null
  const gainVal = document.getElementById(`${prefix}-gain-val`) as HTMLSpanElement | null

  const transportButtons = [playBtn, pauseBtn, stopBtn, loopBtn].filter(
    (button): button is HTMLButtonElement => button !== null,
  )
  transportButtons.forEach((button) => {
    button.disabled = true
    button.title = 'Use Audiotool Studio transport'
    button.setAttribute('aria-label', 'Project transport is controlled in Audiotool Studio')
  })

  volSlider?.addEventListener('input', () => {
    deck.volume = parseFloat(volSlider.value)
    if (volVal) volVal.textContent = String(Math.round(deck.volume * 100))
    ensureCtx(deck)
    applyDeckPreviewGain(deck)
    void applyDeckProjectLevels(deckIndex)
  })

  gainSlider?.addEventListener('input', () => {
    deck.gainTrim = parseFloat(gainSlider.value)
    if (gainVal) gainVal.textContent = `${deck.gainTrim.toFixed(1)}x`
    ensureCtx(deck)
    applyDeckPreviewGain(deck)
    void applyDeckProjectLevels(deckIndex)
  })

  setupWaveformSeek(prefix, deckIndex)
  syncTransportUi(prefix, deck)
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
  btnConnect.onclick = () => connectProject()
  btnDisconnect.onclick = () => disconnectAll()
  btnOpenAudiotool.onclick = () => openAudiotoolProjectTab()
  btnAudioCapture.onclick = () => { void ensureLiveAudioCapture().catch(() => {}) }
  resetAudioCaptureAvailability()
  el<HTMLButtonElement>('btn-create-project').onclick = () => createNewProject()

  setupDropZone('drop-1', 0)
  setupDropZone('drop-2', 1)
  setupUnloadButton(0)
  setupUnloadButton(1)
  updateSourceDeckUi(0)
  updateSourceDeckUi(1)
  wireTransport('d1', 0)
  wireTransport('d2', 1)
  wireTransport('d3', 2)
  document.querySelectorAll<HTMLCanvasElement>('.eq-knob').forEach(initKnob)

  btnGenerate.addEventListener('click', generateMagicAudio)
  drawMagicIdle()

  init()
}

document.addEventListener('DOMContentLoaded', initApp)
