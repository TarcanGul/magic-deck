const OAUTH_CALLBACK_PARAMS = [
  'code',
  'scope',
  'state',
  'error',
  'error_description',
]

/**
 * Returns a callback URL with stale OAuth parameters removed.
 *
 * A callback is current only when its state exactly matches the state saved
 * when the PKCE flow started. Valid callbacks must remain untouched so Nexus
 * can validate the state and exchange their authorization code.
 */
export function staleOAuthCallbackUrl(href, expectedState) {
  const url = new URL(href)
  const code = url.searchParams.get('code')
  if (code === null) return null

  const returnedState = url.searchParams.get('state')
  if (expectedState !== null && returnedState === expectedState) return null

  for (const param of OAUTH_CALLBACK_PARAMS) {
    url.searchParams.delete(param)
  }
  return url.href
}
