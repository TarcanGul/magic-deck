import test from 'node:test'
import assert from 'node:assert/strict'
import { Ticks } from '@audiotool/nexus/utils'
import {
  TRANSPORT_CHANNEL,
  barToPositionTicks,
  composeLaunchPositionAction,
  guardedTransportTicks,
  matchProjectTabs,
  mergeTransportPositions,
  moveLaunchPosition,
  parseTransportPosition,
  planRegionCancel,
  planRegionLaunch,
  planRegionStop,
  projectIdFromUrl,
  resolveLaunchTick,
  transportPositionToTicks,
  validateTransportResponse,
} from '../transport-extension/transport-utils.js'

test('parses one-based Audiotool transport counters', () => {
  const capturedAt = 123
  assert.deepEqual(parseTransportPosition('001.03.240', capturedAt), {
    bar: 1, beat: 3, tick: 240, precision: 'tick', capturedAt,
  })
  assert.deepEqual(parseTransportPosition('12:4', capturedAt), {
    bar: 12, beat: 4, precision: 'beat', capturedAt,
  })
  assert.deepEqual(parseTransportPosition('BAR 9', capturedAt), {
    bar: 9, precision: 'bar', capturedAt,
  })
  assert.deepEqual(parseTransportPosition('Transport position — Bar: 42 Beat: 3', capturedAt), {
    bar: 42, beat: 3, precision: 'beat', capturedAt,
  })
})

test('merges compatible counter precision and rejects ambiguous positions', () => {
  const capturedAt = 500
  const barOnly = { bar: 9, precision: 'bar', capturedAt }
  const beatOnly = { bar: 9, beat: 3, precision: 'beat', capturedAt }
  const full = { bar: 9, beat: 3, tick: 120, precision: 'tick', capturedAt }
  assert.deepEqual(mergeTransportPositions([barOnly, beatOnly, full]), full)
  assert.equal(
    mergeTransportPositions([beatOnly, { ...beatOnly, beat: 4 }]),
    null,
  )
  assert.equal(
    mergeTransportPositions([full, { ...full, tick: 121 }]),
    null,
  )
})

test('rejects invalid or unrelated counter text', () => {
  assert.equal(parseTransportPosition('0.4.000'), null)
  assert.equal(parseTransportPosition('12.5.000'), null)
  assert.equal(parseTransportPosition('12.0.000'), null)
  assert.equal(parseTransportPosition(`12.1.${Ticks.Beat}`), null)
  assert.equal(parseTransportPosition('120 BPM'), null)
  assert.equal(parseTransportPosition('01:00'), null)
  assert.equal(parseTransportPosition('No transport position'), null)
  assert.equal(parseTransportPosition(''), null)
})

test('extracts and matches an exact connected project id', () => {
  const projectId = '123e4567-e89b-12d3-a456-426614174000'
  assert.equal(
    projectIdFromUrl(`https://beta.audiotool.com/studio?project=${projectId}`),
    projectId,
  )
  assert.equal(
    projectIdFromUrl(`https://beta.audiotool.com/projects/${projectId}`),
    projectId,
  )

  const tabs = [
    { id: 1, url: 'https://beta.audiotool.com/studio?project=other-project' },
    { id: 2, url: `https://beta.audiotool.com/studio?project=${projectId}` },
  ]
  assert.deepEqual(matchProjectTabs(tabs, projectId), { ok: true, tab: tabs[1] })
  assert.deepEqual(
    matchProjectTabs(tabs, 'missing-project'),
    { ok: false, reason: 'project-tab-not-found' },
  )
})

test('rejects ambiguous matching project tabs', () => {
  const projectId = 'shared-project'
  const result = matchProjectTabs([
    { id: 3, url: `https://beta.audiotool.com/studio?project=${projectId}` },
    { id: 4, url: `https://beta.audiotool.com/studio?project=${projectId}` },
  ], projectId)
  assert.deepEqual(result, { ok: false, reason: 'multiple-project-tabs' })
})

test('accepts only a fresh response for the exact request and project', () => {
  const now = 10_000
  const expected = { requestId: 'request-1', projectId: 'project-1' }
  const response = {
    channel: TRANSPORT_CHANNEL,
    type: 'response',
    requestId: expected.requestId,
    projectId: expected.projectId,
    ok: true,
    bar: 8,
    beat: 2,
    tick: 0,
    precision: 'tick',
    raw: '008.02.000',
    capturedAt: now - 1_500,
  }
  assert.deepEqual(validateTransportResponse(response, expected, now), {
    ok: true,
    position: {
      bar: 8,
      beat: 2,
      tick: 0,
      precision: 'tick',
      capturedAt: now - 1_500,
    },
    raw: '008.02.000',
  })
  assert.deepEqual(
    validateTransportResponse({ ...response, capturedAt: now - 2_001 }, expected, now),
    { ok: false, reason: 'stale-response' },
  )
  assert.deepEqual(
    validateTransportResponse({ ...response, projectId: 'project-2' }, expected, now),
    { ok: false, reason: 'project-mismatch' },
  )
  assert.deepEqual(
    validateTransportResponse({ ...response, requestId: 'request-2' }, expected, now),
    { ok: false, reason: 'request-mismatch' },
  )
})

test('rejects invalid response precision and tick ranges', () => {
  const now = 20_000
  const expected = { requestId: 'request-2', projectId: 'project-1' }
  const response = {
    channel: TRANSPORT_CHANNEL,
    type: 'response',
    requestId: expected.requestId,
    projectId: expected.projectId,
    ok: true,
    bar: 2,
    beat: 5,
    capturedAt: now,
  }
  assert.deepEqual(validateTransportResponse(response, expected, now), {
    ok: false,
    reason: 'invalid-position',
  })
  assert.equal(
    transportPositionToTicks(
      { bar: 1, beat: 1, tick: Ticks.Beat - 1, precision: 'tick', capturedAt: now },
      Ticks.Beat,
      Ticks.Bars(1),
    ),
    Ticks.Beat - 1,
  )
  assert.throws(
    () => transportPositionToTicks(
      { bar: 1, beat: 1, tick: Ticks.Beat, precision: 'tick', capturedAt: now },
      Ticks.Beat,
      Ticks.Bars(1),
    ),
    /invalid/,
  )
})

test('converts a one-based bar to its bar-start Nexus ticks', () => {
  const ticksPerBar = Ticks.Bars(1)
  assert.equal(barToPositionTicks(1, ticksPerBar), Ticks.Bars(0))
  assert.equal(barToPositionTicks(7, ticksPerBar), Ticks.Bars(6))
  assert.throws(() => barToPositionTicks(0, ticksPerBar), /one-based whole number/)
  assert.throws(() => barToPositionTicks(1.5, ticksPerBar), /one-based whole number/)
  assert.throws(
    () => barToPositionTicks(Number.MAX_SAFE_INTEGER, ticksPerBar),
    /safe tick range/,
  )
})

test('conservatively converts bar, beat, and tick captures', () => {
  const bar = Ticks.Bars(1)
  assert.equal(
    transportPositionToTicks(
      { bar: 3, precision: 'bar', capturedAt: 0 },
      Ticks.Beat,
      bar,
    ),
    Ticks.Bars(3) - 1,
  )
  assert.equal(
    transportPositionToTicks(
      { bar: 3, beat: 2, precision: 'beat', capturedAt: 0 },
      Ticks.Beat,
      bar,
    ),
    Ticks.Bars(2) + (Ticks.Beat * 2) - 1,
  )
  assert.equal(
    transportPositionToTicks(
      { bar: 3, beat: 2, tick: 120, precision: 'tick', capturedAt: 0 },
      Ticks.Beat,
      bar,
    ),
    Ticks.Bars(2) + Ticks.Beat + 120,
  )
})

test('guards captures by response age and delivery time across BPM limits', () => {
  const position = { bar: 1, beat: 1, tick: 0, precision: 'tick', capturedAt: 1_000 }
  for (const bpm of [40, 120, 240]) {
    const guarded = guardedTransportTicks(
      position,
      bpm,
      1_250,
      Ticks.Beat,
      Ticks.Bars(1),
    )
    assert.equal(guarded, Math.ceil(1_000 * bpm * Ticks.Beat / 60_000))
  }
})

test('rounds to safe next-bar and four-bar phrase boundaries', () => {
  const bar = Ticks.Bars(1)
  assert.equal(resolveLaunchTick('next-bar', 0, bar), bar)
  assert.equal(resolveLaunchTick('next-bar', bar, bar), bar * 2)
  assert.equal(resolveLaunchTick('next-phrase', 0, bar), bar * 4)
  assert.equal(resolveLaunchTick('next-phrase', bar * 4, bar), bar * 8)
  assert.equal(resolveLaunchTick('exact-bar', bar * 3 - 1, bar, 4), bar * 3)
  assert.equal(resolveLaunchTick('exact-bar', bar * 3, bar, 4), null)
  assert.equal(resolveLaunchTick('exact-bar', bar * 5, bar, 4), null)
  assert.throws(
    () => resolveLaunchTick('next-bar', Number.MAX_SAFE_INTEGER, bar),
    /safe tick range|boundary/,
  )
})

test('moves an individual deck region by beats, bars, and four-bar blocks', () => {
  const beat = Ticks.Beat
  const bar = Ticks.Bars(1)
  const currentPosition = bar * 8 + beat * 2
  assert.equal(moveLaunchPosition(currentPosition, 'previous-beat', beat, bar), currentPosition - beat)
  assert.equal(moveLaunchPosition(currentPosition, 'next-beat', beat, bar), currentPosition + beat)
  assert.equal(moveLaunchPosition(currentPosition, 'previous-bar', beat, bar), currentPosition - bar)
  assert.equal(moveLaunchPosition(currentPosition, 'next-bar', beat, bar), currentPosition + bar)
  assert.equal(
    moveLaunchPosition(currentPosition, 'previous-four-bars', beat, bar),
    currentPosition - bar * 4,
  )
  assert.equal(
    moveLaunchPosition(currentPosition, 'next-four-bars', beat, bar),
    currentPosition + bar * 4,
  )
})

test('composes every launch direction and step', () => {
  assert.equal(composeLaunchPositionAction('previous', 'beat'), 'previous-beat')
  assert.equal(composeLaunchPositionAction('next', 'beat'), 'next-beat')
  assert.equal(composeLaunchPositionAction('previous', 'bar'), 'previous-bar')
  assert.equal(composeLaunchPositionAction('next', 'bar'), 'next-bar')
  assert.equal(composeLaunchPositionAction('previous', 'four-bars'), 'previous-four-bars')
  assert.equal(composeLaunchPositionAction('next', 'four-bars'), 'next-four-bars')
})

test('rejects deck region movement before bar 1 or beyond safe ticks', () => {
  const beat = Ticks.Beat
  const bar = Ticks.Bars(1)
  assert.throws(
    () => moveLaunchPosition(0, 'previous-beat', beat, bar),
    /before bar 1/,
  )
  assert.throws(
    () => moveLaunchPosition(Number.MAX_SAFE_INTEGER, 'next-beat', beat, bar),
    /safe tick range/,
  )
  assert.throws(
    () => moveLaunchPosition(bar, 'reenter-bar', beat, bar),
    /Unknown launch position action/,
  )
})

test('plans launch restoration, cancellation, and quantized stopping', () => {
  const bar = Ticks.Bars(1)
  assert.deepEqual(planRegionLaunch(bar * 8, bar * 12), {
    kind: 'launch',
    positionTicks: bar * 12,
    cueOffsetTicks: 0,
    durationTicks: bar * 8,
    isEnabled: true,
  })
  assert.deepEqual(planRegionCancel(bar * 12, bar * 11), {
    kind: 'cancel',
    isEnabled: false,
  })
  assert.deepEqual(planRegionCancel(bar * 12, bar * 12), {
    kind: 'refuse',
    reason: 'launch-boundary-reached',
  })
  assert.deepEqual(planRegionStop(bar * 8, bar * 8, bar * 8, true, bar * 9, bar * 10), {
    kind: 'stop',
    durationTicks: bar * 2,
  })
  assert.deepEqual(planRegionStop(bar * 12, bar * 8, bar * 8, true, bar * 9, bar * 10), {
    kind: 'cancel',
    isEnabled: false,
  })
  assert.deepEqual(planRegionStop(bar * 8, bar, bar, true, bar * 8, bar * 10), {
    kind: 'noop',
    reason: 'natural-end-first',
  })
  assert.deepEqual(planRegionStop(bar * 8, bar * 2, bar * 8, true, bar * 9, bar * 11), {
    kind: 'noop',
    reason: 'natural-end-first',
  })
})

test('plans cue launches at exact entered bars with rounded offsets and natural duration', () => {
  const ticksPerBar = Ticks.Bars(1)
  const firstTarget = barToPositionTicks(14, ticksPerBar)
  const secondTarget = barToPositionTicks(21, ticksPerBar)
  assert.deepEqual(planRegionLaunch(10_001, firstTarget, 0.25), {
    kind: 'launch',
    positionTicks: firstTarget,
    cueOffsetTicks: 2_500,
    durationTicks: 7_501,
    isEnabled: true,
  })
  assert.deepEqual(planRegionLaunch(10_001, secondTarget, 0.75), {
    kind: 'launch',
    positionTicks: secondTarget,
    cueOffsetTicks: 7_501,
    durationTicks: 2_500,
    isEnabled: true,
  })
  assert.equal(planRegionLaunch(10_001, secondTarget, 0.25).cueOffsetTicks, 2_500)
  assert.throws(() => planRegionLaunch(1, 0, 0.999), /no playable/)
  assert.throws(() => planRegionLaunch(10, 0, 1), /\[0, 1\)/)
})

test('stops cue-launched regions before their natural remaining end', () => {
  const launch = planRegionLaunch(8_000, 20_000, 0.25)
  assert.deepEqual(
    planRegionStop(launch.positionTicks, launch.durationTicks, launch.durationTicks, true, 21_000, 24_000),
    { kind: 'stop', durationTicks: 4_000 },
  )
  assert.deepEqual(
    planRegionStop(launch.positionTicks, 2_000, launch.durationTicks, true, 21_000, 24_000),
    { kind: 'noop', reason: 'natural-end-first' },
  )
})
