import { audiotool } from '@audiotool/nexus'
import type { AuthenticatedClient, SyncedDocument } from '@audiotool/nexus'
import type { NexusEntity } from '@audiotool/nexus/document'

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
}
type DeckPrefix = 'd1' | 'd2' | 'd3'
type WaveformDeckIndex = 0 | 1 | 2
interface ReferenceAudio {
  blob: Blob
  fileName: string
  deckNum: number
  seconds: number
}

const REFERENCE_AUDIO_SECONDS = 8
const MAGIC_DURATION_BARS = 16
const BEATS_PER_BAR = 4

// ── State ─────────────────────────────────────────────────────────────────────
let at: AuthenticatedClient | null = null
let nexus: SyncedDocument | null = null
let magicGainEntity: NexusEntity<'tinyGain'> | null = null
let lastLoadedDeckIndex: 0 | 1 | null = null
let lastPlayedDeckIndex: 0 | 1 | null = null
let currentProjectBpm: number | null = null
let waveformAnimationFrame: number | null = null

const decks: [DeckState, DeckState, DeckState] = [
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1 },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1 },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null, baseBpm: null, pitchPercent: 0, playbackRate: 1 },
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
const magicGain = el<HTMLInputElement>('magic-gain')
const magicGainVal = el<HTMLSpanElement>('magic-gain-val')
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
  magicGainEntity = null
  statusUser.textContent = ''
  projectUrlRow.style.display = 'none'
  btnLogin.style.display = ''
  btnConnect.disabled = true
  btnDisconnect.disabled = true
  setStatus('idle', 'DISCONNECTED — CLICK LOGIN TO RECONNECT')
  init()
}

// ── PROJECT ───────────────────────────────────────────────────────────────────
async function createNewProject() {
  if (!at) { setStatus('error', 'NOT LOGGED IN'); return }
  const name = prompt('Project name?', 'My DJ Set')
  if (!name) return
  setStatus('connecting', `CREATING PROJECT "${name}"…`)
  try {
    const response = await at.projects.createProject({
      project: { displayName: name, description: 'Created from NEXUS DJ' },
    })
    if (response instanceof Error) throw response
    const project = response.project
    if (!project) throw new Error('No project returned')

    const uuid = project.name.replace(/^projects\//, '')
    const url = `https://beta.audiotool.com/studio?project=${uuid}`
    inputProjectUrl.value = url
    localStorage.setItem('nexus_project_url', url)
    setStatus('connected', `PROJECT "${name}" CREATED — CLICK CONNECT PROJECT`)
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
    await initMagicGain()
  } catch (e: unknown) {
    setStatus('error', `PROJECT ERROR: ${e instanceof Error ? e.message : String(e)}`)
    nexus = null
    btnConnect.disabled = false
  }
}

// ── NEXUS ─────────────────────────────────────────────────────────────────────
async function initMagicGain() {
  if (!nexus) return
  try { magicGainEntity = await nexus.modify((t) => t.create('tinyGain', { displayName: 'MAGIC DECK MIX', gain: 0.5 })) }
  catch (e) { console.warn('[NEXUS] tinyGain:', e) }
}
async function updateMagicGain(value: number) {
  if (!nexus || !magicGainEntity) return
  try { const f = magicGainEntity.fields.gain; await nexus.modify((t) => { t.update(f, value) }) }
  catch (e) { console.warn('[NEXUS] gain update:', e) }
}
function updateDeckBpmLabels(bpm: number | null) {
  const value = bpm === null ? '—' : String(Math.round(bpm))
  decks.forEach((deck) => { deck.baseBpm = bpm })
  el('deck1-bpm').textContent = value
  el('deck2-bpm').textContent = value
  el('deck3-bpm').textContent = value
}
function loadBPM() {
  if (!nexus) return
  nexus.events.onCreate('config', (cfg) => {
    nexus!.events.onUpdate(cfg.fields.tempoBpm, (bpm) => {
      const nextBpm = Number(bpm)
      currentProjectBpm = Number.isFinite(nextBpm) ? nextBpm : null
      updateDeckBpmLabels(currentProjectBpm)
    }, true)
  })
}
async function uploadToNexus(deckNum: number, file: File) {
  if (!nexus || !at) return
  setStatus('connected', `UPLOADING ${file.name}…`)
  try {
    const upload = await at.samples.upload({ file, displayName: file.name })
    if (upload instanceof Error) throw upload
    await upload.uploaded
    await nexus.modify((t) => {
      const sample = t.create('sample', { sampleName: upload.name, uploadStartTime: BigInt(Math.floor(Date.now() / 1000)) })
      const device = t.create('audioDevice', { displayName: `DECK ${deckNum} — ${file.name}`, positionX: (deckNum - 1) * 300, positionY: 100 })
      const auto = t.create('automationCollection', {})
      const track = t.create('audioTrack', { player: device.location, orderAmongTracks: deckNum, isEnabled: true })
      t.create('audioRegion', { track: track.location, sample: sample.location, playbackAutomationCollection: auto.location, region: { positionTicks: 0, durationTicks: 15360, collectionOffsetTicks: 0, loopOffsetTicks: 0, loopDurationTicks: 15360 } })
    })
    setStatus('connected', `DECK ${deckNum}: ${file.name} — SYNCED ✓`)
  } catch (e: unknown) { setStatus('error', `UPLOAD ERROR: ${e instanceof Error ? e.message : String(e)}`) }
}

// ── AUDIO ─────────────────────────────────────────────────────────────────────
function ensureCtx(deck: DeckState) {
  if (!deck.audioCtx) {
    deck.audioCtx = new AudioContext(); deck.gainNode = deck.audioCtx.createGain()
    deck.gainNode.connect(deck.audioCtx.destination); deck.gainNode.gain.value = 0.8
  }
}
function clampPitchPercent(value: number) {
  return Math.max(-8, Math.min(8, value))
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
function updateDeckPlaybackRate(deck: DeckState, pitchPercent: number) {
  const nextPitch = clampPitchPercent(pitchPercent)
  const nextRate = Math.max(0.01, 1 + nextPitch / 100)
  if (deck.isPlaying && deck.audioCtx) {
    deck.pauseOffset = getDeckPositionSeconds(deck)
    deck.startedAt = deck.audioCtx.currentTime
  }
  deck.pitchPercent = nextPitch
  deck.playbackRate = nextRate
  if (deck.sourceNode) deck.sourceNode.playbackRate.value = nextRate
}
function deckPlay(deck: DeckState, onEnded?: () => void) {
  if (!deck.audioCtx || !deck.audioBuffer || deck.isPlaying) return
  const src = deck.audioCtx.createBufferSource()
  src.buffer = deck.audioBuffer; src.loop = deck.looping; src.playbackRate.value = deck.playbackRate; src.connect(deck.gainNode!)
  const normalizedOffset = normalizeDeckOffset(deck, deck.pauseOffset)
  src.start(0, normalizedOffset); deck.sourceNode = src
  deck.startedAt = deck.audioCtx.currentTime; deck.pauseOffset = normalizedOffset; deck.isPlaying = true; deck.isPaused = false
  src.onended = () => {
    if (!deck.isPlaying || deck.sourceNode !== src) return
    deck.sourceNode = null; deck.isPlaying = false; deck.isPaused = false; deck.pauseOffset = 0
    redrawDeckWaveformByState(deck)
    onEnded?.()
  }
  scheduleWaveformRendering()
}
function deckPause(deck: DeckState) {
  if (!deck.audioCtx || !deck.isPlaying) return
  deck.pauseOffset = getDeckPositionSeconds(deck)
  const source = deck.sourceNode
  deck.sourceNode = null; deck.isPlaying = false; deck.isPaused = true
  source?.stop()
  redrawDeckWaveformByState(deck)
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
    deckStop(deck); deck.audioBuffer = buf; deck.fileName = file.name
    lastLoadedDeckIndex = deckIndex
    drawWaveform(`waveform-${deckIndex + 1}`, buf)
    uploadToNexus(deckIndex + 1, file)
  } catch (e: unknown) { setStatus('error', `DECODE ERROR: ${e instanceof Error ? e.message : String(e)}`) }
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
  return decks.some((deck) => deck.audioBuffer)
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

function getWaveformClickSeconds(canvas: HTMLCanvasElement, deck: DeckState, event: MouseEvent) {
  if (!deck.audioBuffer || deck.audioBuffer.duration <= 0) return null
  const rect = canvas.getBoundingClientRect()
  const clickedX = Math.max(0, Math.min(event.clientX - rect.left, rect.width))
  const ratio = rect.width > 0 ? clickedX / rect.width : 0
  return ratio * deck.audioBuffer.duration
}

function seekDeck(deck: DeckState, offsetSeconds: number, onEnded?: () => void) {
  if (!deck.audioBuffer) return
  const wasPlaying = deck.isPlaying
  const wasPaused = deck.isPaused
  const source = deck.sourceNode
  const normalizedOffset = normalizeDeckOffset(deck, offsetSeconds)

  deck.sourceNode = null
  deck.isPlaying = false
  deck.isPaused = wasPaused
  deck.pauseOffset = normalizedOffset
  source?.stop()

  if (wasPlaying) {
    deck.isPaused = false
    deckPlay(deck, onEnded)
  } else {
    redrawDeckWaveformByState(deck)
  }
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
function initKnob(canvas: HTMLCanvasElement) {
  const init = parseFloat(canvas.dataset.value ?? '0.5')
  knobState.set(canvas, { value: init, dragging: false, startY: 0, startVal: init })
  drawKnob(canvas, init)
  canvas.addEventListener('mousedown', (e) => { const s = knobState.get(canvas)!; s.dragging = true; s.startY = e.clientY; s.startVal = s.value; e.preventDefault() })
  window.addEventListener('mousemove', (e) => { const s = knobState.get(canvas); if (!s?.dragging) return; s.value = Math.max(0, Math.min(1, s.startVal + (s.startY - e.clientY) / 120)); drawKnob(canvas, s.value) })
  window.addEventListener('mouseup', () => { const s = knobState.get(canvas); if (s) s.dragging = false })
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
  if (lastPlayedDeckIndex !== null && decks[lastPlayedDeckIndex].isPlaying && decks[lastPlayedDeckIndex].audioBuffer) {
    return { deck: decks[lastPlayedDeckIndex], deckIndex: lastPlayedDeckIndex }
  }
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
    magicDeck.audioBuffer = generatedBuffer
    magicDeck.fileName = generatedFile.name
    if (magicDeck.gainNode) magicDeck.gainNode.gain.value = parseFloat(magicGain.value)
    drawWaveform('magic-waveform', generatedBuffer)
    deckPlay(magicDeck, () => syncTransportUi('d3', magicDeck))
    syncTransportUi('d3', magicDeck)
    uploadToNexus(3, generatedFile)

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
  const deck = decks[deckIndex]
  canvas.addEventListener('click', (event) => {
    const offsetSeconds = getWaveformClickSeconds(canvas, deck, event)
    if (offsetSeconds === null) return
    const wasPlaying = deck.isPlaying
    seekDeck(deck, offsetSeconds, () => syncTransportUi(prefix, deck))
    if (wasPlaying && (deckIndex === 0 || deckIndex === 1)) lastPlayedDeckIndex = deckIndex
    syncTransportUi(prefix, deck)
  })
}
function wireTransport(prefix: DeckPrefix, deckIndex: 0 | 1 | 2) {
  const deck = decks[deckIndex]
  const playBtn = el<HTMLButtonElement>(`${prefix}-play`), pauseBtn = el<HTMLButtonElement>(`${prefix}-pause`)
  const volSlider = document.getElementById(`${prefix}-vol`) as HTMLInputElement | null
  const volVal = document.getElementById(`${prefix}-vol-val`) as HTMLSpanElement | null

  playBtn.addEventListener('click', () => {
    deckPlay(deck, () => syncTransportUi(prefix, deck))
    if (deckIndex === 0 || deckIndex === 1) lastPlayedDeckIndex = deckIndex
    syncTransportUi(prefix, deck)
  })
  pauseBtn.addEventListener('click', () => { deckPause(deck); syncTransportUi(prefix, deck) })
  el<HTMLButtonElement>(`${prefix}-stop`).addEventListener('click', () => { deckStop(deck); syncTransportUi(prefix, deck) })
  el<HTMLButtonElement>(`${prefix}-loop`).addEventListener('click', () => {
    deck.looping = !deck.looping
    if (deck.sourceNode) deck.sourceNode.loop = deck.looping
    syncTransportUi(prefix, deck)
  })
  volSlider?.addEventListener('input', () => {
    const v = parseFloat(volSlider.value)
    if (volVal) volVal.textContent = String(Math.round(v * 100))
    ensureCtx(deck)
    if (deck.gainNode) deck.gainNode.gain.value = v
  })

  if (prefix === 'd3') {
    const pitchWheel = el<HTMLInputElement>('d3-pitch-wheel')
    const pitchReset = el<HTMLButtonElement>('d3-pitch-reset')
    const setMagicPitch = (value: number) => {
      updateDeckPlaybackRate(deck, value)
      pitchWheel.value = deck.pitchPercent.toFixed(1)
      syncTransportUi(prefix, deck)
    }

    pitchWheel.addEventListener('input', () => setMagicPitch(parseFloat(pitchWheel.value)))
    pitchWheel.addEventListener('dblclick', () => setMagicPitch(0))
    pitchReset.addEventListener('click', () => setMagicPitch(0))
  }

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
  magicGain.addEventListener('input', async () => {
    const v = parseFloat(magicGain.value)
    const magicDeck = decks[2]
    magicGainVal.textContent = `${Math.round(v * 100)}%`
    if (magicDeck.gainNode) magicDeck.gainNode.gain.value = v
    await updateMagicGain(v)
  })
  btnGenerate.addEventListener('click', generateMagicAudio)
  drawMagicIdle()

  init()
}

document.addEventListener('DOMContentLoaded', initApp)
