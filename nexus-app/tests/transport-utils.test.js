import test from 'node:test'
import assert from 'node:assert/strict'
import { Ticks } from '@audiotool/nexus/utils'
import {
  TRANSPORT_CHANNEL,
  barToPositionTicks,
  matchProjectTabs,
  parseTransportBar,
  projectIdFromUrl,
  validateTransportResponse,
} from '../transport-extension/transport-utils.js'

test('parses one-based Audiotool transport counters', () => {
  assert.equal(parseTransportBar('001.03.240'), 1)
  assert.equal(parseTransportBar('12:4:000'), 12)
  assert.equal(parseTransportBar('27 | 2 | 120'), 27)
  assert.equal(parseTransportBar('BAR 9'), 9)
  assert.equal(parseTransportBar('Transport position — Bar: 42 Beat: 3'), 42)
})

test('rejects invalid or unrelated counter text', () => {
  assert.equal(parseTransportBar('0.4.000'), null)
  assert.equal(parseTransportBar('120 BPM'), null)
  assert.equal(parseTransportBar('01:00'), 1)
  assert.equal(parseTransportBar('No transport position'), null)
  assert.equal(parseTransportBar(''), null)
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
    raw: '008.02.000',
    capturedAt: now - 1_500,
  }
  assert.deepEqual(validateTransportResponse(response, expected, now), {
    ok: true,
    bar: 8,
    raw: '008.02.000',
    capturedAt: now - 1_500,
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
