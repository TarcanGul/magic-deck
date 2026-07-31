import assert from 'node:assert/strict'
import test from 'node:test'

import { staleOAuthCallbackUrl } from '../src/auth-utils.js'

test('preserves a current OAuth callback for Nexus to validate', () => {
  const href = 'http://127.0.0.1:5173/?code=fresh&state=expected'

  assert.equal(staleOAuthCallbackUrl(href, 'expected'), null)
})

test('removes a stale OAuth callback without dropping unrelated URL state', () => {
  const href = 'http://127.0.0.1:5173/?code=old&state=old&scope=project%3Awrite&view=deck#assistant'

  assert.equal(
    staleOAuthCallbackUrl(href, 'expected'),
    'http://127.0.0.1:5173/?view=deck#assistant',
  )
})

test('removes an orphaned OAuth callback when no login state exists', () => {
  const href = 'http://127.0.0.1:5173/?code=old&state=old'

  assert.equal(staleOAuthCallbackUrl(href, null), 'http://127.0.0.1:5173/')
})

test('ignores ordinary application URLs', () => {
  const href = 'http://127.0.0.1:5173/?view=deck'

  assert.equal(staleOAuthCallbackUrl(href, null), null)
})
