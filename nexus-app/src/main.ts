import { audiotool } from '@audiotool/nexus'
import { Ticks } from '@audiotool/nexus/utils'
import type { AuthenticatedClient, SyncedDocument } from '@audiotool/nexus'
import type { SampleMeta } from '@audiotool/nexus/api'
import type { NexusEntity, SafeTransactionBuilder } from '@audiotool/nexus/document'

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
  sampleBpm: number | null; regionEntity: NexusEntity<'audioRegion'> | null
  trackEntity: NexusEntity<'audioTrack'> | null; audioDeviceEntity: NexusEntity<'audioDevice'> | null
  mixerChannelEntity: NexusEntity<'mixerChannel'> | null
}
type DeckPrefix = 'd1' | 'd2' | 'd3'
type WaveformDeckIndex = 0 | 1 | 2
type EqBand = 'hi' | 'mid' | 'low'
interface ReferenceAudio {
  blob: Blob
  fileName: string
  deckNum: number
  seconds: number
}

const REFERENCE_AUDIO_SECONDS = 8
const MAGIC_DURATION_BARS = 16
const BEATS_PER_BAR = 4
const PROJECT_PRE_GAIN_BASE = 0.39810699224472046

// ── State ─────────────────────────────────────────────────────────────────────
let at: AuthenticatedClient | null = null
let nexus: SyncedDocument | null = null
let lastLoadedDeckIndex: 0 | 1 | null = null
let currentProjectBpm: number | null = null
let waveformAnimationFrame: number | null = null

const decks: [DeckState, DeckState, DeckState] = [
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, volume: 0.8, gainTrim: 1, sampleBpm: null, regionEntity: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, volume: 0.8, gainTrim: 1, sampleBpm: null, regionEntity: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: true, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1, volume: 0.8, gainTrim: 1, sampleBpm: null, regionEntity: null, trackEntity: null, audioDeviceEntity: null, mixerChannelEntity: null },
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
const inputProjectUrl = el<HTMLInputElement>('input-project-url')
const magentaUrl = el<HTMLInputElement>('magenta-url')
const btnGenerate = el<HTMLButtonElement>('btn-generate')
const magicDot = el<HTMLSpanElement>('magic-dot')
const magicStatusLabel = el<HTMLSpanElement>('magic-status-label')
const magicPrompt = el<HTMLInputElement>('magic-prompt')
const magicAudioWeight = el<HTMLInputElement>('magic-audio-weight')
const magicTextWeight = el<HTMLInputElement>('magic-text-weight')
const audioWeightVal = el<HTMLSpanElement>('audio-weight-val')
const textWeightVal = el<HTMLSpanElement>('text-weight-val')
const magicWaveform = el<HTMLCanvasElement>('magic-waveform')

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatus(state: 'idle' | 'connecting' | 'connected' | 'error', msg: string) {
  statusDot.className = `dot ${state}`
  statusText.textContent = msg
  console.log(`[STATUS] ${state}: ${msg}`)
}
function setMagicStatus(state: 'idle' | 'generating' | 'error' | 'done', label: string) {
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
      btnConnect.disabled = false
      btnDisconnect.disabled = false
      if (window.location.search.includes('code=')) {
        window.history.replaceState({}, '', '/')
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
  if (nexus) { try { await nexus.stop() } catch (_) {}; nexus = null }
  if (at) { try { at.logout() } catch (_) {}; at = null }
  decks.forEach(clearDeckProjectEntities)
  statusUser.textContent = ''
  projectUrlRow.style.display = 'none'
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
  try {
    nexus = await at.open(projectUrl)
    nexus.connected.subscribe((c) => setStatus(c ? 'connected' : 'error', c ? 'SYNCED ↔ PROJECT ACTIVE' : 'CONNECTION LOST…'))
    loadBPM()
    await nexus.start()
    setStatus('connected', 'SYNCED ↔ PROJECT ACTIVE')
    localStorage.setItem('nexus_project_url', projectUrl)
  } catch (e: unknown) {
    setStatus('error', `PROJECT ERROR: ${e instanceof Error ? e.message : String(e)}`)
    nexus = null
    btnConnect.disabled = false
  }
}

// ── NEXUS ─────────────────────────────────────────────────────────────────────
function updateDeckBpmLabels(bpm: number | null) {
  currentProjectBpm = bpm
  decks.forEach((deck, index) => {
    if (deck.sampleBpm === null) deck.baseBpm = bpm
    updateDeckBpmLabel(index as WaveformDeckIndex)
  })
}
function updateDeckBpmLabel(deckIndex: WaveformDeckIndex) {
  const deck = decks[deckIndex]
  const value = deck.sampleBpm ?? deck.baseBpm
  el(`deck${deckIndex + 1}-bpm`).textContent = value === null ? '—' : String(Math.round(value))
}
function loadBPM() {
  if (!nexus) return
  nexus.events.onCreate('config', (cfg) => {
    nexus!.events.onUpdate(cfg.fields.tempoBpm, (bpm) => {
      const nextBpm = Number(bpm)
      updateDeckBpmLabels(Number.isFinite(nextBpm) ? nextBpm : null)
    }, true)
  })
}

function clearDeckProjectEntities(deck: DeckState) {
  deck.sampleBpm = null
  deck.regionEntity = null
  deck.trackEntity = null
  deck.audioDeviceEntity = null
  deck.mixerChannelEntity = null
}

function getDetectedOrProjectBpm(sample: SampleMeta, deckNum: number) {
  if (Number.isFinite(sample.bpm) && sample.bpm > 0) return sample.bpm
  if (currentProjectBpm && currentProjectBpm > 0) {
    setStatus('connected', `DECK ${deckNum}: NO BPM DETECTED — USING PROJECT BPM ${Math.round(currentProjectBpm)}`)
    return currentProjectBpm
  }
  throw new Error('No sample BPM detected and project BPM is unavailable')
}

function knobValueToEqDb(value: number) {
  return Math.max(-18, Math.min(18, (value - 0.5) * 36))
}

async function uploadSample(file: File, displayName: string) {
  if (!at) throw new Error('Not logged in')
  const upload = await at.samples.upload({ file, displayName, kind: 'loop' })
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

  return { track, audioDevice, mixerChannel }
}

async function insertSampleIntoProject(deckNum: number, sample: SampleMeta, displayName: string, forceMagicLoop: boolean) {
  if (!nexus) throw new Error('Project not connected')
  const deck = decks[deckNum - 1]
  const bpm = getDetectedOrProjectBpm(sample, deckNum)

  const inserted = await nexus.modify((t) => {
    const region = t.insertSample(sample, {
      sample: { bpm },
      region: forceMagicLoop
        ? { positionTicks: 0, durationTicks: Ticks.Bars(64) }
        : { positionTicks: 0 },
      loop: forceMagicLoop ? true : undefined,
      displayName,
    })
    const entities = resolveInsertedProjectEntities(region, t)
    return { region, ...entities }
  })

  deck.sampleBpm = sample.bpm > 0 ? sample.bpm : null
  deck.baseBpm = bpm
  deck.regionEntity = inserted.region
  deck.trackEntity = inserted.track
  deck.audioDeviceEntity = inserted.audioDevice
  deck.mixerChannelEntity = inserted.mixerChannel
  updateDeckBpmLabel((deckNum - 1) as WaveformDeckIndex)
  applyCurrentDeckEq((deckNum - 1) as WaveformDeckIndex)
  void applyCurrentDeckLevels((deckNum - 1) as WaveformDeckIndex)
  return inserted
}

async function uploadToNexus(deckNum: number, file: File, forceMagicLoop = false) {
  if (!nexus || !at) throw new Error('Connect an Audiotool project before loading audio')
  setStatus('connected', `UPLOADING ${file.name}…`)
  try {
    const displayName = `${deckNum === 3 ? 'MAGIC DECK' : `DECK ${deckNum}`} — ${file.name}`
    const sample = await uploadSample(file, displayName)
    setStatus('connected', `DECK ${deckNum}: SAMPLE READY — INSERTING PROJECT REGION…`)
    await insertSampleIntoProject(deckNum, sample, displayName, forceMagicLoop)
    setStatus('connected', `DECK ${deckNum}: ${file.name} — PROJECT SYNCED ✓`)
  } catch (e: unknown) {
    setStatus('error', `UPLOAD ERROR: ${e instanceof Error ? e.message : String(e)}`)
    throw e
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
async function loadAudioFile(deckIndex: 0 | 1, file: File) {
  const deck = decks[deckIndex]; ensureCtx(deck)
  try {
    const buf = await deck.audioCtx!.decodeAudioData(await file.arrayBuffer())
    deckStop(deck); clearDeckProjectEntities(deck); deck.audioBuffer = buf; deck.fileName = file.name
    lastLoadedDeckIndex = deckIndex
    drawWaveform(`waveform-${deckIndex + 1}`, buf)
    await uploadToNexus(deckIndex + 1, file)
  } catch (e: unknown) { setStatus('error', `LOAD ERROR: ${e instanceof Error ? e.message : String(e)}`) }
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
function drawMagicIdle(label = '[ GENERATE AUDIO FROM LAST 8 SECONDS ]') {
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

function selectReferenceDeck(): { deck: DeckState; deckIndex: 0 | 1 } | null {
  const playingIndex = decks.findIndex((deck, index) => index < 2 && deck.isPlaying && deck.audioBuffer) as 0 | 1 | -1
  if (playingIndex !== -1) return { deck: decks[playingIndex], deckIndex: playingIndex }
  if (lastLoadedDeckIndex !== null && decks[lastLoadedDeckIndex].audioBuffer) {
    return { deck: decks[lastLoadedDeckIndex], deckIndex: lastLoadedDeckIndex }
  }
  const loadedIndex = decks.findIndex((deck, index) => index < 2 && deck.audioBuffer) as 0 | 1 | -1
  if (loadedIndex !== -1) return { deck: decks[loadedIndex], deckIndex: loadedIndex }
  return null
}

function createReferenceBuffer(deck: DeckState) {
  if (!deck.audioBuffer) throw new Error('No audio loaded')
  ensureCtx(deck)

  const source = deck.audioBuffer
  const sampleRate = source.sampleRate
  const sourceLength = source.length
  const channels = Math.min(source.numberOfChannels, 2)
  const useLoopWindow = deck.looping && (deck.isPlaying || deck.isPaused)
  const endSeconds = deck.isPlaying || deck.isPaused ? getDeckPositionSeconds(deck) : source.duration
  const endSample = useLoopWindow
    ? Math.round(endSeconds * sampleRate)
    : Math.min(sourceLength, Math.max(1, Math.round(endSeconds * sampleRate)))
  const length = useLoopWindow
    ? Math.max(1, Math.round(REFERENCE_AUDIO_SECONDS * sampleRate))
    : Math.max(1, Math.min(Math.round(REFERENCE_AUDIO_SECONDS * sampleRate), endSample))
  const output = deck.audioCtx!.createBuffer(channels, length, sampleRate)
  const startSample = Math.max(0, endSample - length)

  for (let channel = 0; channel < channels; channel++) {
    const input = source.getChannelData(channel)
    const out = output.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      const sourceIndex = useLoopWindow ? ((endSample - length + i) % sourceLength + sourceLength) % sourceLength : startSample + i
      out[i] = input[sourceIndex] ?? 0
    }
  }

  return output
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

function buildReferenceAudio(): ReferenceAudio {
  const selection = selectReferenceDeck()
  if (!selection) throw new Error('Load or play a deck before generating')

  const buffer = createReferenceBuffer(selection.deck)
  return {
    blob: audioBufferToWav(buffer),
    fileName: `deck-${selection.deckIndex + 1}-last-${REFERENCE_AUDIO_SECONDS}s.wav`,
    deckNum: selection.deckIndex + 1,
    seconds: buffer.duration,
  }
}

function magentaEndpoint() {
  return (magentaUrl.value.trim() || 'http://localhost:8000').replace(/\/+$/, '')
}

function getMagicDurationSeconds() {
  if (!currentProjectBpm || currentProjectBpm <= 0) throw new Error('Project BPM required for 16-bar duration')
  return (MAGIC_DURATION_BARS * BEATS_PER_BAR * 60) / currentProjectBpm
}

function describeMagentaError(error: unknown) {
  if (error instanceof TypeError) {
    return `Could not reach Magenta API at ${magentaEndpoint()}. Check that magenta_server.py is running on port 8000.`
  }
  return error instanceof Error ? error.message : 'Error'
}

// ── MAGENTA ───────────────────────────────────────────────────────────────────
async function generateMagicAudio() {
  const promptText = magicPrompt.value.trim()
  const audioWeight = parseFloat(magicAudioWeight.value)
  const textWeight = parseFloat(magicTextWeight.value)
  if (!promptText) { setMagicStatus('error', 'PROMPT REQUIRED'); setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000); return }
  if (audioWeight + textWeight <= 0) { setMagicStatus('error', 'WEIGHTS REQUIRED'); setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000); return }

  setMagicStatus('generating', 'CAPTURING'); btnGenerate.disabled = true
  try {
    const reference = buildReferenceAudio()
    const durationSeconds = getMagicDurationSeconds()
    const form = new FormData()
    form.append('audio_file', reference.blob, reference.fileName)
    form.append('prompt', promptText)
    form.append('audio_weight', String(audioWeight))
    form.append('text_weight', String(textWeight))
    form.append('duration_bars', String(MAGIC_DURATION_BARS))
    form.append('beats_per_bar', String(BEATS_PER_BAR))
    form.append('bpm', String(currentProjectBpm))
    form.append('duration_seconds', String(durationSeconds))
    form.append('stem_role', 'auto')
    form.append('avoid_clash', 'true')

    setMagicStatus('generating', `MAGENTA ← DECK ${reference.deckNum}`)
    const resp = await fetch(`${magentaEndpoint()}/generate`, { method: 'POST', body: form })
    if (!resp.ok) {
      const detail = await resp.text()
      throw new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ''}`)
    }

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
    await uploadToNexus(3, generatedFile, true)

    setMagicStatus('done', `DONE ${Math.round(reference.seconds)}s REF`); setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000)
  } catch (e: unknown) {
    console.error('[MAGENTA] generate:', e)
    const message = describeMagentaError(e)
    setMagicStatus('error', message.toUpperCase().slice(0, 24))
    setTimeout(() => setMagicStatus('idle', 'IDLE'), 4000)
  }
  finally { btnGenerate.disabled = false }
}

// ── DROP ZONES ────────────────────────────────────────────────────────────────
function setupDropZone(zoneId: string, deckIndex: 0 | 1) {
  const zone = document.getElementById(zoneId)!
  const label = document.getElementById(`drop${deckIndex + 1}-filename`)!
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over') })
  zone.addEventListener('dragover',  (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', (e) => { e.stopPropagation(); if (!zone.contains(e.relatedTarget as Node)) zone.classList.remove('drag-over') })
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over')
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    if (!file.name.match(/\.(mp3|wav)$/i)) { setStatus('error', 'ONLY MP3 / WAV FILES ACCEPTED'); return }
    zone.classList.add('loaded'); label.textContent = file.name
    await loadAudioFile(deckIndex, file)
  })
}

// ── TRANSPORT ─────────────────────────────────────────────────────────────────
function syncTransportUi(prefix: DeckPrefix, deck: DeckState) {
  el<HTMLButtonElement>(`${prefix}-play`).classList.toggle('active', deck.isPlaying)
  el<HTMLButtonElement>(`${prefix}-pause`).classList.toggle('active', deck.isPaused)
  el<HTMLButtonElement>(`${prefix}-loop`).classList.toggle('active', deck.looping)
  el<HTMLSpanElement>(`${prefix}-pitch`).textContent = formatPitch(deck.pitchPercent)
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
  const playBtn = el<HTMLButtonElement>(`${prefix}-play`), pauseBtn = el<HTMLButtonElement>(`${prefix}-pause`)
  const stopBtn = el<HTMLButtonElement>(`${prefix}-stop`)
  const loopBtn = el<HTMLButtonElement>(`${prefix}-loop`)
  const volSlider = document.getElementById(`${prefix}-vol`) as HTMLInputElement | null
  const volVal = document.getElementById(`${prefix}-vol-val`) as HTMLSpanElement | null
  const gainSlider = document.getElementById(`${prefix}-gain`) as HTMLInputElement | null
  const gainVal = document.getElementById(`${prefix}-gain-val`) as HTMLSpanElement | null

  const transportButtons = [playBtn, pauseBtn, stopBtn, loopBtn]
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
  btnConnect.onclick = () => connectProject()
  btnDisconnect.onclick = () => disconnectAll()
  el<HTMLButtonElement>('btn-create-project').onclick = () => createNewProject()

  setupDropZone('drop-1', 0)
  setupDropZone('drop-2', 1)
  wireTransport('d1', 0)
  wireTransport('d2', 1)
  wireTransport('d3', 2)
  document.querySelectorAll<HTMLCanvasElement>('.eq-knob').forEach(initKnob)

  magicAudioWeight.addEventListener('input', () => { audioWeightVal.textContent = parseFloat(magicAudioWeight.value).toFixed(1) })
  magicTextWeight.addEventListener('input', () => { textWeightVal.textContent = parseFloat(magicTextWeight.value).toFixed(1) })
  btnGenerate.addEventListener('click', generateMagicAudio)
  drawMagicIdle()

  init()
}

document.addEventListener('DOMContentLoaded', initApp)
