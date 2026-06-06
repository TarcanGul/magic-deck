import { audiotool } from '@audiotool/nexus'
import type { AuthenticatedClient, SyncedDocument } from '@audiotool/nexus'
import type { NexusEntity } from '@audiotool/nexus/document'

// ── OAuth config ──────────────────────────────────────────────────────────────
const CLIENT_ID = 'fa370480-13d6-4cba-8015-f9297a81e9e8'
const REDIRECT_URL = 'http://127.0.0.1:5173/'
const SCOPE = 'project:write sample:write'

// ── Types ─────────────────────────────────────────────────────────────────────
interface MidiNote { pitch: number; startTime: number; endTime: number; velocity: number }
interface DeckState {
  audioCtx: AudioContext | null; sourceNode: AudioBufferSourceNode | null
  gainNode: GainNode | null; audioBuffer: AudioBuffer | null
  isPlaying: boolean; isPaused: boolean; pauseOffset: number
  startedAt: number; looping: boolean; fileName: string | null
}

// ── State ─────────────────────────────────────────────────────────────────────
let at: AuthenticatedClient | null = null
let nexus: SyncedDocument | null = null
let magicGainEntity: NexusEntity<'tinyGain'> | null = null

const decks: [DeckState, DeckState] = [
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null },
  { audioCtx: null, sourceNode: null, gainNode: null, audioBuffer: null, isPlaying: false, isPaused: false, pauseOffset: 0, startedAt: 0, looping: false, fileName: null },
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
const magicTemp = el<HTMLInputElement>('magic-temp')
const magicSteps = el<HTMLInputElement>('magic-steps')
const tempVal = el<HTMLSpanElement>('temp-val')
const stepsVal = el<HTMLSpanElement>('steps-val')
const magicGain = el<HTMLInputElement>('magic-gain')
const magicGainVal = el<HTMLSpanElement>('magic-gain-val')
const pianoRoll = el<HTMLCanvasElement>('piano-roll')

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
    await nexus.start()
    setStatus('connected', 'SYNCED ↔ PROJECT ACTIVE')
    localStorage.setItem('nexus_project_url', projectUrl)
    loadBPM()
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
function loadBPM() {
  if (!nexus) return
  nexus.events.onCreate('config', (cfg) => {
    nexus!.events.onUpdate(cfg.fields.tempoBpm, (bpm) => {
      const v = String(Math.round(Number(bpm)))
      el('deck1-bpm').textContent = v; el('deck2-bpm').textContent = v
    })
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
function deckPlay(deck: DeckState) {
  if (!deck.audioCtx || !deck.audioBuffer || deck.isPlaying) return
  const src = deck.audioCtx.createBufferSource()
  src.buffer = deck.audioBuffer; src.loop = deck.looping; src.connect(deck.gainNode!)
  const off = deck.isPaused ? deck.pauseOffset : 0
  src.start(0, off); deck.sourceNode = src
  deck.startedAt = deck.audioCtx.currentTime - off; deck.isPlaying = true; deck.isPaused = false
  src.onended = () => { if (deck.isPlaying) { deck.isPlaying = false; deck.pauseOffset = 0 } }
}
function deckPause(deck: DeckState) {
  if (!deck.audioCtx || !deck.isPlaying) return
  deck.pauseOffset = deck.audioCtx.currentTime - deck.startedAt
  deck.sourceNode?.stop(); deck.sourceNode = null; deck.isPlaying = false; deck.isPaused = true
}
function deckStop(deck: DeckState) {
  deck.sourceNode?.stop(); deck.sourceNode = null
  deck.isPlaying = false; deck.isPaused = false; deck.pauseOffset = 0
}
async function loadAudioFile(deckIndex: 0 | 1, file: File) {
  const deck = decks[deckIndex]; ensureCtx(deck)
  try {
    const buf = await deck.audioCtx!.decodeAudioData(await file.arrayBuffer())
    deckStop(deck); deck.audioBuffer = buf; deck.fileName = file.name
    drawWaveform(`waveform-${deckIndex + 1}`, buf)
    uploadToNexus(deckIndex + 1, file)
  } catch (e: unknown) { setStatus('error', `DECODE ERROR: ${e instanceof Error ? e.message : String(e)}`) }
}

// ── WAVEFORM ──────────────────────────────────────────────────────────────────
function drawWaveform(id: string, buf: AudioBuffer) {
  const canvas = el<HTMLCanvasElement>(id), ctx = canvas.getContext('2d')!
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

// ── PIANO ROLL ────────────────────────────────────────────────────────────────
function drawPianoRoll(notes: MidiNote[]) {
  const ctx = pianoRoll.getContext('2d')!
  const W = pianoRoll.width, H = pianoRoll.height, MIN = 36, MAX = 84, RANGE = MAX - MIN, ROW = H / RANGE
  ctx.fillStyle = '#050000'; ctx.fillRect(0, 0, W, H)
  for (let p = MIN; p <= MAX; p += 12) {
    const y = H - ((p - MIN) / RANGE) * H
    ctx.strokeStyle = '#1a0000'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    ctx.fillStyle = '#440000'; ctx.font = '9px IBM Plex Mono'; ctx.fillText(`C${Math.floor(p / 12) - 1}`, 2, y - 2)
  }
  if (!notes.length) { ctx.fillStyle = '#440000'; ctx.font = '12px Share Tech Mono'; ctx.textAlign = 'center'; ctx.fillText('[ PRESS GENERATE TO SEE AI MIDI ]', W / 2, H / 2); ctx.textAlign = 'left'; return }
  const maxT = Math.max(...notes.map(n => n.endTime), 1)
  for (const n of notes) {
    const p = Math.max(MIN, Math.min(MAX - 1, n.pitch)), x = (n.startTime / maxT) * W, nw = Math.max(3, ((n.endTime - n.startTime) / maxT) * W - 1)
    const y = H - ((p - MIN + 1) / RANGE) * H, vel = n.velocity / 127, gb = Math.round((1 - vel) * 200)
    ctx.fillStyle = `rgba(255,${gb},${gb},${0.7 + vel * 0.3})`; ctx.fillRect(x, y + 1, nw, ROW - 2)
  }
}

// ── MAGENTA ───────────────────────────────────────────────────────────────────
async function generateMidi() {
  setMagicStatus('generating', 'GENERATING'); btnGenerate.disabled = true
  try {
    const url = magentaUrl.value.trim() || 'http://localhost:5000'
    const resp = await fetch(`${url}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temperature: parseFloat(magicTemp.value), steps: parseInt(magicSteps.value) }) })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    drawPianoRoll(Array.isArray(data) ? data : (data.notes ?? []))
    setMagicStatus('done', 'DONE'); setTimeout(() => setMagicStatus('idle', 'IDLE'), 2000)
  } catch (e: unknown) { setMagicStatus('error', 'ERROR'); setTimeout(() => setMagicStatus('idle', 'IDLE'), 3000) }
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
function wireTransport(prefix: 'd1' | 'd2', deckIndex: 0 | 1) {
  const deck = decks[deckIndex]
  const playBtn = el<HTMLButtonElement>(`${prefix}-play`), pauseBtn = el<HTMLButtonElement>(`${prefix}-pause`)
  const volSlider = el<HTMLInputElement>(`${prefix}-vol`), volVal = el<HTMLSpanElement>(`${prefix}-vol-val`)
  playBtn.addEventListener('click', () => { deckPlay(deck); playBtn.classList.add('active'); pauseBtn.classList.remove('active') })
  pauseBtn.addEventListener('click', () => { deckPause(deck); pauseBtn.classList.add('active'); playBtn.classList.remove('active') })
  el<HTMLButtonElement>(`${prefix}-stop`).addEventListener('click', () => { deckStop(deck); playBtn.classList.remove('active'); pauseBtn.classList.remove('active') })
  el<HTMLButtonElement>(`${prefix}-loop`).addEventListener('click', function () { deck.looping = !deck.looping; this.classList.toggle('active', deck.looping); if (deck.sourceNode) deck.sourceNode.loop = deck.looping })
  volSlider.addEventListener('input', () => { const v = parseFloat(volSlider.value); volVal.textContent = String(Math.round(v * 100)); ensureCtx(deck); if (deck.gainNode) deck.gainNode.gain.value = v })
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
  document.querySelectorAll<HTMLCanvasElement>('.eq-knob').forEach(initKnob)

  magicTemp.addEventListener('input', () => { tempVal.textContent = parseFloat(magicTemp.value).toFixed(2) })
  magicSteps.addEventListener('input', () => { stepsVal.textContent = magicSteps.value })
  magicGain.addEventListener('input', async () => { const v = parseFloat(magicGain.value); magicGainVal.textContent = `${Math.round(v * 100)}%`; await updateMagicGain(v) })
  btnGenerate.addEventListener('click', generateMidi)
  drawPianoRoll([])

  init()
}

document.addEventListener('DOMContentLoaded', initApp)