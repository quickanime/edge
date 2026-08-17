# Edge

End-to-end encrypted team messaging, calls, tasks and meetings — deployed on
Netlify with no third-party services or API keys. The interface is English by
default and switches to Turkish from the profile screen.

Türkçe özet: Edge, uçtan uca şifreli bir ekip mesajlaşma platformudur. Sunucu
yalnızca şifreli veriyi saklar; anahtarlar cihazda kalır. Arayüz dili profil
ekranından değiştirilir.

## What it does

- **End-to-end encrypted messaging** — direct chats and group channels. Text,
  photos and files are encrypted in the browser; the server only stores
  ciphertext.
- **Voice, video and screen sharing** — WebRTC, peer to peer, with 720p/1080p/4K
  selection. Signalling is relayed by the server but encrypted for the peer.
- **Companies, groups and invite links** — every company and group gets a short
  link id (for example `edgeishere.netlify.app/vertex`); people join through the
  link instead of being added one by one. Links can be use-limited.
- **Granular admin access** — the owner grants the admin panel and then narrows
  it: members, groups, tasks, meetings, invites are separate permissions.
- **Tasks** — a three-column board with drag and drop, priorities, due dates and
  assignment to a person **or** a group. "My tasks" collects everything assigned
  to you and to your groups.
- **Meetings** — schedule a voice or video meeting for a group or the whole
  company; attendees get a notification and can join with one click.
- **Friends** — add someone by nickname; direct chat opens once accepted, or if
  you already share a company.
- **Extras** — read receipts, typing indicator, disappearing messages, profile
  photos and company logos, activity log ("who did what"), and a best-effort
  screenshot notice.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

`PORT` changes the port, `EDGE_DATA_DIR` the local data directory. Locally the
data lives in JSON files under `data/store`; on Netlify it lives in Netlify
Blobs. The same core code runs in both.

## Deploy to Netlify

The repository is deploy-ready:

- `netlify.toml` publishes `public/`, routes `/api/*` and `/auth/*` to a single
  function, sends every other path to `index.html` (so invite links work), and
  sets the security headers.
- `netlify/functions/api.mjs` is the whole backend; storage is Netlify Blobs, so
  there is nothing to provision and no API key anywhere.

Connect the repository in Netlify and deploy. To verify a deployment, open
`/api/health` — it should return `{"ok":true,"store":"blobs"}`. If it returns
HTML instead, the function did not deploy and the Netlify deploy log will say
why.

## How the encryption works

| Step | What happens |
| --- | --- |
| Sign up | The browser generates an ECDH P-256 identity key. The public key goes to the server; the private key is sealed with `PBKDF2(password, salt, 250k)` + AES-GCM and only the sealed blob is stored. |
| Sign in | The server never sees the password — it receives `PBKDF2(password, "edge-auth\|nick")` and verifies it with a second salt and `scrypt`. The sealed private key is downloaded and opened locally. |
| Sending | Each message gets a random AES-256-GCM key. The body is encrypted with it, and that key is wrapped separately for every recipient using `ECDH + HKDF-SHA256`. Photos and files reuse the same message key with their own IV. |
| Reading | The recipient opens their own envelope, recovers the message key and decrypts. |
| Calls | Media is peer to peer and encrypted by WebRTC itself (DTLS-SRTP). The offer/answer packets are additionally encrypted for the peer, so the server carries them blindly. |
| Verifying | Profile and chat screens show a **fingerprint** of the public key; comparing it over another channel confirms who you are talking to. |

Reloading the page clears the keys from memory, which is why an unlock screen
asks for the password again.

**Deliberate limits:** task titles, company and group names, nicknames and
profile photos are stored in plain form — listing, filtering and permission
checks run on them. What is encrypted is message content and attachments.
Someone who joins a group later cannot read messages sent before they joined.
Screenshot detection is best effort: browsers do not report screenshots, so only
PrintScreen and the macOS shortcuts are caught — a phone camera never will be.

## Security

`npm run test:security` throws 500+ attacks at a running server and fails if any
of them succeeds: forged sessions, cross-account access (IDOR), privilege
escalation, path traversal and injection in every id field, prototype pollution,
forged senders and attachments, information leaks, oversized payloads, session
reuse after sign-out, invite abuse, brute force and message flooding.

Hardening in place:

- every id that reaches a storage key is format-checked (32-hex, slug, room id)
- sliding-window rate limits per user and per IP: sign-in, sign-up, search,
  friend requests, invites, messages, uploads, images, calls, events
- unknown nicknames get a consistent decoy salt and a constant-cost comparison,
  so accounts cannot be enumerated
- sessions expire after 30 days; message bodies, key envelope counts and file
  sizes are capped
- strict CSP (no external scripts, styles or fonts), HSTS, `frame-ancestors
  'none'`, `nosniff`, COOP/CORP
- authentication uses bearer tokens, not cookies, so CSRF does not apply

## Layout

```
core/          business logic shared by Netlify and local dev
  api.mjs        routes: auth, companies, groups, chats, tasks, meetings, calls
  security.mjs   validation, rate limiting, anti-enumeration
  store.mjs      key/value storage: Netlify Blobs or local files
  util.mjs       ids, hashing, permissions
netlify/functions/api.mjs   the deployed backend
server/dev.mjs              local server (static files + same core)
public/        the app: i18n.js, crypto.js, net.js, store.js, chat.js,
               panel.js, tasks.js, friends.js, call.js, media.js, app.js
tests/         api.test.mjs · ui.test.mjs (two real browsers) · security.test.mjs
```

## Tests

```bash
npm start                 # in another terminal
npm test                  # API and crypto flow: 20 checks
npm run test:security     # 500+ attack attempts
npm run test:ui           # two real browsers, end to end, including a WebRTC call
```

The UI test needs Playwright (`npm i -D playwright`) and a full Chromium build
for camera and microphone access. Screen sharing is skipped unless
`EDGE_TEST_SCREENSHARE=1` is set, because the source picker belongs to the
browser. `EDGE_RATE_MULTIPLIER` widens the rate limits for repeated test runs.
