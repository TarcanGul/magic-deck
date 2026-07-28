# Magic Deck Audiotool Transport extension

This unpacked Chrome/Edge extension implements the
`magic-deck.transport.v2` contract. It reads only Audiotool Studio's visible
bar/beat/tick transport counter and returns the most precise unambiguous
one-based project position to the local Magic Deck app. It does not access
cookies, OAuth tokens, page storage, or unrelated page data.

## Install

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `transport-extension` directory.
4. Reload both `https://beta.audiotool.com/…` and
   `http://127.0.0.1:5173/` after installing or updating the extension.

Keep exactly one Audiotool Studio tab open for the connected project. If the
extension is missing, finds zero or multiple matching project tabs, or cannot
read a unique visible transport counter, Magic Deck asks for the relevant
launch, stop, or current bar instead of guessing. Older extension versions do
not satisfy the v2 handshake and therefore use the same safe manual fallback.
