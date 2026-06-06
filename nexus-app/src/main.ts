import { audiotool } from '@audiotool/nexus'
import type { AuthenticatedClient, SyncedDocument } from '@audiotool/nexus'
import type { NexusEntity } from '@audiotool/nexus/document'

// ─── Types ────────────────────────────────────────────────────────────────────

interface MidiNote {
  pitch: number
  startTime: number
  endTime: number
  velocity: number
}

interface DeckState {
  audioCtx: AudioContext | null
  sourceNode: AudioBufferSourceNode | null
  gainNode: GainNode | null
  audioBuffer: AudioBuffer | null
  isPlaying: boolean
  isPaused: boolean
  pauseOffset: number
  startedAt: number
  looping: boolean
  fileName: string | null
}

// ─── App State ────────────────────────────────────────────────────────────────

let at: AuthenticatedClient | null = null
let nexus: SyncedDocument | null = null
let magicGainEntity: NexusEntity<'tinyGain'> | null = null

const decks: [DeckState, DeckState] = [
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null },
]

const knobState: Map<HTMLCanvasElement, { value: number; dragging: boolean; startY: number; startVal: number }> = new Map()

// ─── DOM Refs ─────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const statusDot = $<HTMLSpanElement>('status-dot')
const statusText = $<HTMLSpanElement>('status-text')
const statusUser = $<HTMLDivElement>('status-user')
const btnLogin = $<HTMLButtonElement>('btn-login')
const btnConnect = $<HTMLButtonElement>('btn-connect')
const btnDisconnect = $<HTMLButtonElement>('btn-disconnect')
const inputClientId = $<HTMLInputElement>('input-client-id')
const inputProjectUrl = $<HTMLInputElement>('input-project-url')

const magentaUrl = $<HTMLInputElement>('magenta-url')
const btnGenerate = $<HTMLButtonElement>('btn-generate')
const magicDot = $<HTMLSpanElement>('magic-dot')
const magicStatusLabel = $<HTMLSpanElement>('magic-status-label')
const magicTemp = $<HTMLInputElement>('magic-temp')
const magicSteps = $<HTMLInputElement>('magic-steps')
const tempVal = $<HTMLSpanElement>('temp-val')
const stepsVal = $<HTMLSpanElement>('steps-val')
const magicGain = $<HTMLInputElement>('magic-gain')
const magicGainVal = $<HTMLSpanElement>('magic-gain-val')
const pianoRoll = $<HTMLCanvasElement>('piano-roll')

// ─── Status helpers ───────────────────────────────────────────────────────────

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'error', msg: string) {
  statusDot.className = `dot ${state}`
  statusText.textContent = msg
}

function setMagicStatus(state: 'idle' | 'generating' | 'error' | 'done', label: string) {
  magicDot.className = `status-dot-magic ${state}`
  magicStatusLabel.textContent = label
}

// ─── OAuth / Connection ───────────────────────────────────────────────────────

const HARDCODED_CLIENT_ID = 'fa370480-13d6-4cba-8015-f9297a81e9e8'

async function initAuth() {
  const clientId = inputClientId.value.trim() || HARDCODED_CLIENT_ID
  inputClientId.value = clientId

  setStatus('connecting', 'AUTHENTICATING…')
  btnLogin.disabled = true

  try {
    const result = await audiotool({
      clientId,
      redirectUrl: 'http://127.0.0.1:5173/',
      scope: 'project:write',
    })

    if (result.status === 'authenticated') {
      at = result
      statusUser.textContent = result.userName.toUpperCase()
      setStatus('connected', `AUTHENTICATED AS ${result.userName.toUpperCase()}`)
      btnConnect.disabled = false
      btnDisconnect.disabled = false
    } else {
      // Not yet authenticated — wire the login button to trigger redirect
      btnLogin.disabled = false
      if (result.error) {
        setStatus('error', `AUTH ERROR: ${result.error.message}`)
      } else {
        setStatus('idle', 'CLICK LOGIN TO AUTHENTICATE')
        // Override: clicking login now does the actual redirect
        btnLogin.onclick = () => {
          result.login()
        }
      }
    }
  } catch (e: unknown) {
    btnLogin.disabled = false
    const msg = e instanceof Error ? e.message : String(e)
    setStatus('error', `AUTH FAILED: ${msg}`)
  }
}

async function connectProject() {
  if (!at) return
  const projectUrl = inputProjectUrl.value.trim()
  if (!projectUrl) {
    setStatus('error', 'ENTER A PROJECT URL FIRST')
    return
  }

  setStatus('connecting', 'OPENING PROJECT…')
  try {
    nexus = await at.open(projectUrl)

    nexus.connected.subscribe((connected) => {
      if (!connected) {
        setStatus('error', 'CONNECTION LOST — RECONNECTING…')
      } else {
        setStatus('connected', 'SYNCED ↔ PROJECT ACTIVE')
      }
    })

    await nexus.start()
    setStatus('connected', 'SYNCED ↔ PROJECT ACTIVE')

    loadBPM()
    await initMagicGain()

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    setStatus('error', `PROJECT ERROR: ${msg}`)
    nexus = null
  }
}

async function disconnect() {
  if (nexus) {
    try { await nexus.stop() } catch (_) {}
    nexus = null
  }
  if (at) {
    try { at.logout() } catch (_) {}
    at = null
  }
  magicGainEntity = null
  statusUser.textContent = ''
  setStatus('idle', 'DISCONNECTED')
  btnLogin.disabled = false
  btnLogin.onclick = initAuth
  btnConnect.disabled = true
  btnDisconnect.disabled = true
}

// ─── Nexus: Magic Deck TinyGain ───────────────────────────────────────────────

async function initMagicGain() {
  if (!nexus) return
  try {
    magicGainEntity = await nexus.modify((t) => {
      return t.create('tinyGain', { displayName: 'MAGIC DECK MIX', gain: 0.5 })
    })
    console.log('[NEXUS] tinyGain created', magicGainEntity)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[NEXUS] tinyGain create error:', msg)
  }
}

async function updateMagicGain(value: number) {
  if (!nexus || !magicGainEntity) return
  try {
    const gainField = magicGainEntity.fields.gain
    await nexus.modify((t) => { t.update(gainField, value) })
  } catch (e) {
    console.warn('[NEXUS] gain update error', e)
  }
}

function loadBPM() {
  if (!nexus) return
  try {
    nexus.events.onCreate('config', (config) => {
      nexus!.events.onUpdate(config.fields.tempoBpm, (bpm) => {
        document.getElementById('deck1-bpm')!.textContent = String(Math.round(Number(bpm)))
        document.getElementById('deck2-bpm')!.textContent = String(Math.round(Number(bpm)))
      })
    })
  } catch (_) {}
}

// ─── Audio Engine ─────────────────────────────────────────────────────────────

function ensureAudioCtx(deck: DeckState) {
  if (!deck.audioCtx) {
    deck.audioCtx = new AudioContext()
    deck.gainNode = deck.audioCtx.createGain()
    deck.gainNode.connect(deck.audioCtx.destination)
    deck.gainNode.gain.value = 0.8
  }
}

function deckPlay(deck: DeckState) {
  if (!deck.audioCtx || !deck.audioBuffer || deck.isPlaying) return
  const source = deck.audioCtx.createBufferSource()
  source.buffer = deck.audioBuffer
  source.loop = deck.looping
  source.connect(deck.gainNode!)
  const offset = deck.isPaused ? deck.pauseOffset : 0
  source.start(0, offset)
  deck.sourceNode = source
  deck.startedAt = deck.audioCtx.currentTime - offset
  deck.isPlaying = true
  deck.isPaused = false
  source.onended = () => { if (deck.isPlaying) { deck.isPlaying = false; deck.pauseOffset = 0 } }
}

function deckPause(deck: DeckState) {
  if (!deck.audioCtx || !deck.isPlaying) return
  deck.pauseOffset = deck.audioCtx.currentTime - deck.startedAt
  deck.sourceNode?.stop()
  deck.sourceNode = null
  deck.isPlaying = false
  deck.isPaused = true
}

function deckStop(deck: DeckState) {
  if (!deck.audioCtx) return
  deck.sourceNode?.stop()
  deck.sourceNode = null
  deck.isPlaying = false
  deck.isPaused = false
  deck.pauseOffset = 0
}

async function loadAudioFile(deckIndex: 0 | 1, file: File) {
  const deck = decks[deckIndex]
  ensureAudioCtx(deck)
  const arrayBuffer = await file.arrayBuffer()
  try {
    const audioBuffer = await deck.audioCtx!.decodeAudioData(arrayBuffer)
    deckStop(deck)
    deck.audioBuffer = audioBuffer
    deck.fileName = file.name
    drawWaveform(`waveform-${deckIndex + 1}`, audioBuffer)
    if (nexus && at) uploadToNexus(deckIndex + 1, file, file.name)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    setStatus('error', `DECODE ERROR: ${msg}`)
  }
}

// ─── Nexus: Audio Upload ──────────────────────────────────────────────────────

async function uploadToNexus(deckNum: number, file: File, name: string) {
  if (!nexus || !at) return
  setStatus('connected', `UPLOADING ${name} TO NEXUS…`)
  try {
    const uploadResult = await at.samples.upload({ file, displayName: name })
    if (uploadResult instanceof Error) throw uploadResult
    await uploadResult.uploaded
    const sampleName = uploadResult.name

    await nexus.modify((t) => {
      const sample = t.create('sample', { sampleName, uploadStartTime: BigInt(Math.floor(Date.now() / 1000)) })
      const audioDevice = t.create('audioDevice', { displayName: `DECK ${deckNum} — ${name}`, positionX: (deckNum - 1) * 300, positionY: 100, gain: 0.7079399824142456 })
      const automationCollection = t.create('automationCollection', {})
      const audioTrack = t.create('audioTrack', { player: audioDevice.location, orderAmongTracks: deckNum, isEnabled: true })
      t.create('audioRegion', { track: audioTrack.location, sample: sample.location, playbackAutomationCollection: automationCollection.location, region: { positionTicks: 0, durationTicks: 15360, collectionOffsetTicks: 0, loopOffsetTicks: 0, loopDurationTicks: 15360 } })
      return audioDevice
    })
    setStatus('connected', `DECK ${deckNum}: ${name} — SYNCED TO NEXUS`)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    setStatus('error', `NEXUS UPLOAD ERROR: ${msg}`)
  }
}

// ─── Waveform ─────────────────────────────────────────────────────────────────

function drawWaveform(canvasId: string, buffer: AudioBuffer) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height
  const data = buffer.getChannelData(0)
  const step = Math.ceil(data.length / W)
  const mid = H / 2

  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = '#333'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke()

  for (let i = 0; i < W; i++) {
    let minV = 1.0, maxV = -1.0
    for (let j = 0; j < step; j++) {
      const d = data[i * step + j]
      if (d !== undefined) { if (d < minV) minV = d; if (d > maxV) maxV = d }
    }
    ctx.strokeStyle = `rgb(${Math.round(60 + (i / W) * 144)},0,0)`
    ctx.beginPath(); ctx.moveTo(i, mid + minV * mid * 0.9); ctx.lineTo(i, mid + maxV * mid * 0.9); ctx.stroke()
  }
  for (let y = 0; y < H; y += 4) { ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(0, y, W, 1) }
}

// ─── EQ Knobs ─────────────────────────────────────────────────────────────────

function drawKnob(canvas: HTMLCanvasElement, value: number) {
  const ctx = canvas.getContext('2d')!
  const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2
  const r = Math.min(W, H) / 2 - 4
  ctx.clearRect(0, 0, W, H)
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = '#111'; ctx.fill(); ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1; ctx.stroke()
  const startA = Math.PI * 0.75, endA = Math.PI * 2.25, currA = startA + (endA - startA) * value
  ctx.beginPath(); ctx.arc(cx, cy, r - 5, startA, endA); ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, r - 5, startA, currA); ctx.strokeStyle = '#CC0000'; ctx.lineWidth = 4; ctx.stroke()
  const ix = cx + Math.cos(currA) * (r - 10), iy = cy + Math.sin(currA) * (r - 10)
  ctx.beginPath(); ctx.arc(ix, iy, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill()
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fillStyle = '#333'; ctx.fill()
}

function initKnob(canvas: HTMLCanvasElement) {
  const initial = parseFloat(canvas.dataset.value ?? '0.5')
  knobState.set(canvas, { value: initial, dragging: false, startY: 0, startVal: initial })
  drawKnob(canvas, initial)
  canvas.addEventListener('mousedown', (e) => { const s = knobState.get(canvas)!; s.dragging = true; s.startY = e.clientY; s.startVal = s.value; e.preventDefault() })
  window.addEventListener('mousemove', (e) => { const s = knobState.get(canvas); if (!s || !s.dragging) return; s.value = Math.max(0, Math.min(1, s.startVal + (s.startY - e.clientY) / 120)); drawKnob(canvas, s.value) })
  window.addEventListener('mouseup', () => { const s = knobState.get(canvas); if (s) s.dragging = false })
}

// ─── Piano Roll ───────────────────────────────────────────────────────────────

function drawPianoRoll(notes: MidiNote[]) {
  const ctx = pianoRoll.getContext('2d')!
  const W = pianoRoll.width, H = pianoRoll.height
  const MIN_PITCH = 36, MAX_PITCH = 84, PITCH_RANGE = MAX_PITCH - MIN_PITCH
  const ROW_H = H / PITCH_RANGE

  ctx.fillStyle = '#050000'; ctx.fillRect(0, 0, W, H)

  for (let p = MIN_PITCH; p <= MAX_PITCH; p += 12) {
    const y = H - ((p - MIN_PITCH) / PITCH_RANGE) * H
    ctx.strokeStyle = '#1a0000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    ctx.fillStyle = '#440000'; ctx.font = '9px IBM Plex Mono'; ctx.fillText(`C${Math.floor(p / 12) - 1}`, 2, y - 2)
  }

  const blackKeys = [1, 3, 6, 8, 10]
  for (let p = MIN_PITCH; p < MAX_PITCH; p++) {
    if (blackKeys.includes(p % 12)) { ctx.fillStyle = 'rgba(30,0,0,0.6)'; ctx.fillRect(0, H - ((p - MIN_PITCH + 1) / PITCH_RANGE) * H, W, ROW_H) }
  }

  if (!notes.length) {
    ctx.fillStyle = '#440000'; ctx.font = '12px Share Tech Mono'; ctx.textAlign = 'center'
    ctx.fillText('[ PRESS GENERATE TO SEE AI MIDI ]', W / 2, H / 2); ctx.textAlign = 'left'; return
  }

  const maxTime = Math.max(...notes.map(n => n.endTime), 1)
  for (let i = 0; i <= 16; i++) { const x = (i / 16) * W; ctx.strokeStyle = 'rgba(100,0,0,0.2)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }

  for (const note of notes) {
    const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH - 1, note.pitch))
    const x = (note.startTime / maxTime) * W
    const noteW = Math.max(3, ((note.endTime - note.startTime) / maxTime) * W - 1)
    const y = H - ((pitch - MIN_PITCH + 1) / PITCH_RANGE) * H
    const vel = note.velocity / 127
    const gb = Math.round((1 - vel) * 200)
    ctx.fillStyle = `rgba(255,${gb},${gb},${0.7 + vel * 0.3})`; ctx.fillRect(x, y + 1, noteW, ROW_H - 2)
    ctx.fillStyle = `rgba(255,255,255,${vel * 0.4})`; ctx.fillRect(x, y + 1, noteW, 2)
  }
}

// ─── Magenta Generate ─────────────────────────────────────────────────────────

async function generateMidi() {
  const url = magentaUrl.value.trim() || 'http://localhost:5000'
  setMagicStatus('generating', 'GENERATING')
  btnGenerate.disabled = true
  try {
    const resp = await fetch(`${url}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temperature: parseFloat(magicTemp.value), steps: parseInt(magicSteps.value) }) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    drawPianoRoll(Array.isArray(data) ? data : (data.notes ?? []))
    setMagicStatus('done', 'DONE')
    setTimeout(() => setMagicStatus('idle', 'IDLE'), 2000)
  } catch (e: unknown) {
    setMagicStatus('error', 'ERROR')
    setStatus('error', `MAGENTA ERROR: ${e instanceof Error ? e.message : String(e)}`)
    setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000)
  } finally {
    btnGenerate.disabled = false
  }
}

// ─── Drop Zones ───────────────────────────────────────────────────────────────

function setupDropZone(zoneId: string, deckIndex: 0 | 1) {
  const zone = document.getElementById(zoneId)!
  const filenameEl = document.getElementById(`drop${deckIndex + 1}-filename`)!
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag-over')
    const file = (e as DragEvent).dataTransfer?.files?.[0]
    if (!file) return
    if (!file.name.match(/\.(mp3|wav)$/i)) { setStatus('error', 'ONLY MP3 / WAV FILES ACCEPTED'); return }
    zone.classList.add('loaded')
    filenameEl.textContent = file.name
    await loadAudioFile(deckIndex, file)
  })
}

// ─── Transport ────────────────────────────────────────────────────────────────

function wireTransport(prefix: 'd1' | 'd2', deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  const playBtn = $<HTMLButtonElement>(`${prefix}-play`)
  const pauseBtn = $<HTMLButtonElement>(`${prefix}-pause`)
  const loopBtn = $<HTMLButtonElement>(`${prefix}-loop`)
  const volSlider = $<HTMLInputElement>(`${prefix}-vol`)
  const volVal = $<HTMLSpanElement>(`${prefix}-vol-val`)

  playBtn.addEventListener('click', () => { deckPlay(deck); playBtn.classList.add('active'); pauseBtn.classList.remove('active') })
  pauseBtn.addEventListener('click', () => { deckPause(deck); pauseBtn.classList.add('active'); playBtn.classList.remove('active') })
  $<HTMLButtonElement>(`${prefix}-stop`).addEventListener('click', () => { deckStop(deck); playBtn.classList.remove('active'); pauseBtn.classList.remove('active') })
  loopBtn.addEventListener('click', function () { deck.looping = !deck.looping; this.classList.toggle('active', deck.looping); if (deck.sourceNode) deck.sourceNode.loop = deck.looping })
  volSlider.addEventListener('input', () => { const v = parseFloat(volSlider.value); volVal.textContent = String(Math.round(v * 100)); ensureAudioCtx(deck); if (deck.gainNode) deck.gainNode.gain.value = v })
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function initApp() {
  // Prevent browser from navigating to dropped files globally
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => e.preventDefault())

  // Wire buttons
  btnLogin.addEventListener('click', initAuth)
  btnConnect.addEventListener('click', connectProject)
  btnDisconnect.addEventListener('click', disconnect)

  setupDropZone('drop-1', 0)
  setupDropZone('drop-2', 1)
  wireTransport('d1', 0)
  wireTransport('d2', 1)

  document.querySelectorAll<HTMLCanvasElement>('.eq-knob').forEach(initKnob)

  magicTemp.addEventListener('input', () => { tempVal.textContent = parseFloat(magicTemp.value).toFixed(2) })
  magicSteps.addEventListener('input', () => { stepsVal.textContent = magicSteps.value })
  magicGain.addEventListener('input', async () => { const v = parseFloat(magicGain.value); magicGainVal.textContent = `${Math.round(v * 100)}%`; await updateMagicGain(v) })
  btnGenerate.addEventListener('click', generateMidi)

  drawPianoRoll([])

  // Pre-fill hardcoded client ID
  if (!inputClientId.value) inputClientId.value = HARDCODED_CLIENT_ID

  // Restore saved inputs
  const savedId = localStorage.getItem('nexus_client_id')
  if (savedId) inputClientId.value = savedId
  const savedProject = localStorage.getItem('nexus_project_url')
  if (savedProject) inputProjectUrl.value = savedProject
  inputClientId.addEventListener('input', () => localStorage.setItem('nexus_client_id', inputClientId.value))
  inputProjectUrl.addEventListener('input', () => localStorage.setItem('nexus_project_url', inputProjectUrl.value))

  // If returning from OAuth redirect, complete the auth flow automatically
  if (window.location.search.includes('code=') || window.location.hash.includes('access_token')) {
    initAuth()
  } else {
    setStatus('idle', 'ENTER CLIENT ID AND CLICK LOGIN')
  }
}

document.addEventListener('DOMContentLoaded', initApp)