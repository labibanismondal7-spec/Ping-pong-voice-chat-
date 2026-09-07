# High-Value Gift & Big-Win Room Notification System — Implementation Notes

Implements the spec exactly as scoped: server-validated events only,
zero hard-coded room IDs/names, room-scoped delivery, 5s auto-dismiss,
tap-to-navigate, and a fix for the gift-chat message that was missing
sender/receiver.

## Files changed

- **`roomEvents.js`** (new) — thresholds + event-payload builders.
  No transaction authority (per §13): never touches diamonds/coins,
  never decides room membership. Pure functions the caller feeds
  already-validated data into.
- **`server.js`**
  - `require("./roomEvents.js")` near the other module requires.
  - `send-gift` socket handler (the multi-recipient gift loop): after
    the real transaction commits and the existing `gift-received` event
    is emitted, if `perTargetAmount >= HIGH_VALUE_GIFT_THRESHOLD` a
    `room-event` (`HIGH_VALUE_GIFT`) is emitted to `io.to(roomId)`.
  - `fwResolveSpin` (Fruit Wheel payout resolver): after a winner's
    coins are credited and saved, if `amount >= BIG_WIN_THRESHOLD` a
    `room-event` (`BIG_WIN`) is emitted to `io.to(roomId)`.
  - Both reuse the *existing* `io.to(roomId).emit(...)` call pattern,
    which is already Redis-adapter-backed (`redis/socketAdapter.js`) —
    no new cross-instance delivery code was needed or added.
- **`public/app.js`**
  - New `socket.on("room-event", ...)` listener + a small dedupe/queue/
    flyout system (`handleRoomEvent`, `drainRoomEventQueue`,
    `showRoomEventFlyout`, `navigateToRoomEvent`).
  - Navigation on tap reuses the existing `joinRoom()` (already handles
    "already in that room" no-op, safe leave/join, and the Agora/
    voice-SFU lifecycle) — no separate nav path was built.
  - **Bug fix (§4):** `appendGiftMsg` was silently dropping sender and
    receiver names from the room-chat gift notice (the HTML template
    only rendered the gift icon/name — confirmed by unused `.who` /
    `.gift-notice-arrow` CSS classes already sitting in `style.css` for
    exactly this purpose). It now renders `Sender → Receiver: Gift`,
    plus a diamond-value line for gifts at/above the display threshold.
- **`public/style.css`**
  - `.gift-notice-value` (chat notice diamond-value text).
  - `#room-event-layer` + `.room-event-card` (+enter/exit keyframes) —
    the centered flyout notification, z-index 9500 (below the
    full-screen video-gift-overlay's 9999, above normal room UI).

## How room scoping works (§8)

Nothing new was built for "only that room's users see it" — the
existing `io.to(roomId).emit(...)` Socket.IO room already IS that
scope (only sockets that joined via `join-room` are in it). Both new
emits reuse that exact mechanism, so isolation is automatic and free.

## Event payload (matches spec §9)

```js
// HIGH_VALUE_GIFT
{ eventId, type: "HIGH_VALUE_GIFT", roomId, roomName,
  sender: { userId, name }, receiver: { userId, name },
  gift: { giftId, name, value, icon, quantity },
  displayDurationMs, timestamp }

// BIG_WIN
{ eventId, type: "BIG_WIN", roomId, roomName,
  player: { userId, name }, amount, gameName,
  displayDurationMs, timestamp }
```

`eventId` is a server-generated UUID; the client dedupes on it (§11)
and keeps a small bounded `Set` so a reconnect/duplicate delivery never
re-plays the animation.

## Configuration (§14)

Defaults live in `roomEvents.js` and are overridable via env vars
without a code change:

```
HIGH_VALUE_GIFT_THRESHOLD = 100000
BIG_WIN_THRESHOLD = 1000000
ROOM_EVENT_DISPLAY_DURATION_MS = 5000
```

## What was intentionally NOT touched

- `send-video-gift` — video gifts already have their own full-screen
  overlay (`video-gift-play` / `.video-gift-overlay`, z-index 9999),
  which already fully covers the flyout layer while playing, so a
  redundant flyout for those was skipped to avoid double-notification.
  If you want High-Value Gift flyouts to also fire for video gifts,
  the same `roomEvents.isHighValueGift(...)` + emit block can be added
  to `send-video-gift`'s per-target loop the same way.
- Other game types besides Fruit Wheel — none currently pay out real
  coins/diamonds server-side in this codebase; wire `BIG_WIN` into any
  future game's payout resolver the same way `fwResolveSpin` does it.
- No changes to wallet, chat-ban, moderation, or Agora/voice logic.

## Test-case walkthrough (§17)

- **Gift threshold:** `roomEvents.isHighValueGift(perTargetAmount)` is
  a plain `>=` check against the server constant — 99,999 → false,
  100,000 → true, matching the spec's boundary table exactly.
- **Big Win threshold:** same pattern via `isBigWin(amount)` against
  `BIG_WIN_THRESHOLD`.
- **Room isolation:** guaranteed by Socket.IO room membership, not by
  any client-side "is this my room" check (there isn't one — the event
  simply never reaches a socket outside the room).
- **Navigation:** `navigateToRoomEvent` no-ops if already in the target
  room, otherwise calls the existing `joinRoom()`, which already
  surfaces `room-error` (already wired) for an invalid/deleted/private
  room — the flyout dismisses either way, so the user is never stuck
  waiting on it.
- **Duplicate events:** `roomEventSeenIds` — same `eventId` is a no-op
  on a second delivery.
