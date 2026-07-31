# चिड़िया उड़ 🐦 (Chidiya Udd)

The classic Indian children's game, on a phone. A name flashes ("गाय उड़!") — if the
thing flies, lift your finger off the pad in time; if it doesn't, keep it pressed.
One mistake and you're out. Speed ramps up every round. Trick words included
(penguin doesn't fly, chamgadad does 😈).

Single file, no build, no CDN — house style. `index.html` is the whole game.

## Modes

- **Akele Khelo (solo)** — computer is the caller (Web Speech TTS in hi-IN when
  available). 3 lives, score, best score in `localStorage` (`cu_best`).
- **Ek Phone, Sab Log (party)** — 2–4 players on ONE phone, simultaneously.
  Screen splits into colored zones (top zones rotated 180° for players sitting
  across); each zone is its own multi-touch pad + word display. Last finger
  standing wins.
- **Door Se Khelo (online)** — rooms over WebSocket. Create → 4-letter code →
  share (`#join=CODE` deep link). Host starts, server calls the words and judges
  lifts; eliminated players spectate. Up to 8 per room.

## Worker (`worker/`)

`chidiya-udd` Cloudflare Worker on the **vaibhavpro9210** account —
`https://chidiya-udd.vaibhavpro9210.workers.dev`. One Durable Object per room
code (`/ws/CODE?name=`), all state in-memory, room resets when empty. No secrets.
Deploy: `cd worker && npx wrangler deploy`.

The word list lives in BOTH `index.html` (solo/party) and `worker/worker.js`
(online — server hides `flies` until the verdict). Keep them in sync.

## Gotchas / dev notes

- Screenshot hooks (rAF-free, safe for headless Chrome): `#shot=solo`,
  `#shot=party`, `#shot=lobby`, `#shot=card` (score-card preview modal).
  Remember headless Chrome's ~500px minimum
  window width — shoot at `--window-size=500,1000`.
- Timer bars are CSS-transition based (no rAF at all in the game).
- Round flow: all alive players must HOLD → random 0.6–1.7s sneaky pause → call →
  judge at window end (lift on a no-fly word = instant out). Window starts 2.4s,
  ×0.93 per round, floor 0.9s.
- Protocol test for the worker: two scripted Node clients (native `WebSocket`,
  one always lifts, one never) — game must end after round 1.
