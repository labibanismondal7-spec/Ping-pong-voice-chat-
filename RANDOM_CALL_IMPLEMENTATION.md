# Random Call — Implementation Notes

## Feature overview
"Random Call" lets any authenticated user tap **Start Call** on the Home
page and be connected live to a random *currently eligible* Call Host,
instead of choosing one manually. If the selected host declines, times
out, or is no longer available, the system automatically tries the next
eligible host — up to the pool size — until someone accepts or no one is
left.

**Billing model:** by explicit decision, Random Call reuses the existing
**paid Call Hosting** system as-is — same coins-per-minute rate, same
`minBalance` gate, same daily/duration caps, same revenue ledger. It is
**not** a new free-calling feature; it is a new way to reach an existing
approved host.

## Architecture
```
Random Call Matching (randomCall.js)
        ↓
Existing Call Hosting eligibility + billing (callHosting.js, unchanged)
        ↓
Existing hostcall:* Socket.IO signaling (callHosting.js, unchanged)
        ↓
Existing WebRTC (public/app.js — chAcquireLocalMedia/chCreatePeerConnection, unchanged)
        ↓
Existing #hostcall-overlay video UI (public/index.html, unchanged)
```
`randomCall.js` is a thin, additive module. It contains **no WebRTC, no
billing logic, and no new "host status" fields** — it only decides *which*
host to invite next and calls straight into `callHosting.js`'s existing
`attemptInvite()`.

### Minimal, additive changes to `callHosting.js`
Four small, backward-compatible additions — the existing direct
"Call a Host" feature's behavior, wire format, and error codes are
unchanged (see `test/callSignaling.test.js`-style coverage; full suite
still 38/39, only a pre-existing unrelated test fails):

1. **`attemptInvite(callerId, hostId, callType, callerSocket, opts)`** —
   the exact body of the old `hostcall:invite` handler, extracted into a
   reusable function returning `{ ok, code, callId }` instead of directly
   emitting to a socket. The socket handler now just calls this and
   forwards the error code — zero behavior change for direct calls.
   `opts.ringTimeoutMs` lets a caller override the 45s default (Random
   Call passes 15s per the spec); `opts.meta` is merged into the
   `hostcall:incoming` payload untouched (used to tag `source:
   "random-call"` for the host's UI, purely informational); `opts.hooks`
   (`{ onAccepted, onEnded }`) lets a caller be notified of this specific
   call's outcome without polling or duplicating call-state tracking.
2. **`getEligibleHostIds(excludeUserId)`** — server-authoritative pool:
   approved (`status === "approved"`), has a live socket, not already in
   `userCallState` (busy), and not the caller. This is the *same*
   eligibility `attemptInvite` itself enforces — no duplicate status
   system.
3. **`endCallByParticipant(callId, userId)`** — the exact body of the old
   `hostcall:end` handler, extracted so Random Call's Cancel button can
   end an in-progress hostcall the same server-authoritative way, instead
   of a client emitting an event to itself.
4. **Call-event hooks** (`callEventHooks` map) — fired from the four
   places a `ringing` call can end (ring-timeout, `hostcall:reject`,
   `handleDisconnect`'s ringing-branch, and `endCall()`) and from
   `hostcall:accept`. Each site captures the hook **before** clearing call
   state and invokes it **after** — this ordering matters: firing before
   `clearCall()` would still show the caller as "busy" during the retry
   that follows, silently breaking every automatic next-host attempt.
   (This was caught by `test/randomCall.test.js`, not by inspection.)

### `randomCall.js`
- One session per caller (`sessionsByCaller`), each with a
  `randomCallSessionId`, `callType`, and an `attemptedHostIds` set so the
  same host is never retried within one session (requirement #6/#31).
- `tryNextHost(session)`: computes the live eligible pool minus already-
  attempted hosts, picks one at random, and calls `attemptInvite` with a
  15s ring timeout and hooks wired to itself. `onAccepted` marks the
  session connected and tells the caller. `onEnded` — if the session
  wasn't connected yet — retries the next host; if it *was* connected,
  the underlying call simply ended, so the session ends too.
- Hard ceiling `MAX_ATTEMPTS_PER_SESSION = 25` — infinite-loop guard even
  against a huge or fast-changing pool.
- `random-call:start` is rate-limited (6 attempts / 30s) via the same
  `aiSecurity.isRateLimited` helper every other socket handler in this
  project already uses.
- Cancellation calls `endCallByParticipant` for any live hostcall,
  **after** marking the session ended — otherwise the `onEnded` hook
  fired by that cancellation would try to matchmake a next host during
  what should be a clean cancel.

### Race-condition protection (requirement #11)
Reservation is the same `userCallState.set(hostId, callId)` write
`attemptInvite` already does, executed synchronously with no `await`
between the eligibility check and the reservation. Node's single-threaded
event loop means two simultaneous `random-call:start` calls targeting the
same host cannot interleave mid-check — the second invite necessarily
sees the host as busy. Verified directly in
`test/randomCall.test.js` (two callers, one eligible host, exactly one
reservation wins).

## Socket events (new)
`random-call:start` (client→server, `{ callType }`) · `random-call:start`
(server→client ack, `{ sessionId }`) · `random-call:searching` ·
`random-call:next-host` · `random-call:connected` · `random-call:end` ·
`random-call:cancel` (client→server, `{ sessionId }`)

All underlying call signaling (`hostcall:incoming/ringing/accepted/
ended/offer/answer/ice-candidate/tick/...`) is the existing, unmodified
`callHosting.js` wire format.

## API
No new REST endpoints — Socket.IO only, matching this project's existing
convention for call flows (`callSignaling.js`, `callHosting.js`).

## Database / persistence
No new files. Random Call has no persistent state of its own — it's an
in-memory matching layer over `callhosting_*.json`, which already exists
and already logs every completed call to `callhosting_history.json`
(hostId, callerId, duration, coinsCharged, status, timestamps). Random
Call's history *is* Call Hosting's existing history — no duplicate log.

## UI changes
- **Home page**: one new compact card (`#home-random-call-card`), reusing
  the existing `.home-my-room` layout class and `.btn.btn-accent.btn-sm`
  button style already used elsewhere on Home (`+ Create Room`). No
  existing Home section, tab, or layout was touched.
- **Call UI**: zero new video/call UI. The existing `#hostcall-overlay`
  (incoming/outgoing/active-call states, mute, hangup, secure-mode video
  handling) is reused end to end for Random Call — the only additions are
  status-text updates ("Finding a host...", "Finding another host...")
  driven by the new socket events, and branching the existing Cancel
  button to emit `random-call:cancel` when the active call is a random
  one.

## Testing
`test/randomCall.test.js` (added to `npm test`, discovered automatically
by `test/run-all.js`) exercises real matching logic against mocked
dependencies — not just syntax:
1. `random-call:start` → exactly one host is invited, tagged
   `source: "random-call"`.
2. Decline → automatic retry to a different host.
3. Accept → caller receives both `hostcall:accepted` and
   `random-call:connected`.
4. No eligible hosts → `random-call:end` with `reason: "no-host"`, no
   infinite loop.
5. A host's own pool excludes themselves.
6. **Race protection**: two callers hitting the same sole eligible host
   simultaneously → exactly one reservation succeeds.

Full existing suite: **38/39 passing** (`npm test`). The one failure
(`test/agoraToken.test.js`) is pre-existing and unrelated — that test's
own mock `app` object is missing a `.get()` method; nothing in this
change touches Agora.

### Not verified in this environment (no network / no device access)
- Android build and on-device camera/microphone permission flow
- Real-network TURN/NAT traversal across different network types
- Physical multi-device manual QA of the full test matrix in the spec

These are exactly the categories where "it worked in this sandbox"
wouldn't mean much anyway — they need a real Android build and real
devices/networks, not a code review.

## Environment variables
None added. Random Call reads the same `RANDOM_CALL_RING_TIMEOUT_MS`-
equivalent as a compiled-in constant (`RANDOM_CALL_RING_TIMEOUT_MS =
15000` in `randomCall.js`) rather than an env var, consistent with how
`callHosting.js`'s own `RING_TIMEOUT_MS` and `BILL_INTERVAL_MS` are
defined (compiled-in constants, not env-configurable, in this codebase).

## Troubleshooting
- **"No hosts available right now"**: no approved host is currently
  online and free. Check `/api/admin/call-hosting/hosts?status=approved`
  for the approved roster and whether any are actually connected.
- **Caller never gets `random-call:searching`**: check server logs for
  the rate-limit path (`random-call:end` with `reason: "rate-limited"`)
  or `already-searching` if a prior session wasn't cleaned up (should
  self-clear via `handleDisconnect`).
- **A host reports getting no incoming-call UI for a random call**: the
  host-side UI is 100% the existing `hostcall:incoming` handler — if
  direct "Call a Host" invites work for that host, Random Call invites
  will too, since they're the same event with an extra `source` field the
  client doesn't need to read.
