# CLAUDE.md — EXCELIA Build Rules
# Read this entire file before writing any code. Follow every rule on every change.

---

## What you are building

EXCELIA — a WhatsApp AI real estate chatbot for OMEGA INTELLIGENTSIA GROUP, Togo.
Client: Antipas Komi Attisso.
Stack: Node.js + Express (Railway) | Next.js (Vercel) | PostgreSQL | Cloudinary | WhatsApp Cloud API | Claude (Anthropic) for NLU and reply generation.
Languages: French and English (bilingual — detect per message, respond in same language, switchable mid-conversation on request).
Currency: XOF (CFA franc) — display as "45 000 F CFA". Never convert.

Demo scope (build in this order):
1. Bilingual WhatsApp AI chatbot
2. Property search (city / neighbourhood / type / price / bedrooms)
3. Natural language understanding — free-text input → structured search
4. Auto-send listing photos (WhatsApp image messages)
5. Auto-send listing location (WhatsApp location messages)
6. Lead capture — log who enquired about what
7. Appointment booking for viewings
8. Admin dashboard (properties, leads, conversations)
9. Prospect management pipeline

NOT in this build: owner self-listing portal, subscription/billing, Mobile Money payments.

---

## Current build status — read this first (last updated 2026-08-22)

**Repo:** https://github.com/rcworks16001-sys/Excelia_work, branch `main`, remote `origin`. Push only when explicitly asked — no standing auto-push rule.

### ✅ Done and pushed — do not re-build any of this

**Steps 1–9** (the numbered demo scope above) are all built, verified, and pushed. **Post-demo tasks 1–4** (photo infra, contact number swap, dashboard language toggle, username/password login) are also done — see "Key decisions" below for how each was actually implemented.

**Everything built in the rounds after that** (all pushed to `main`):

- **Dashboard round 1** — search/filter bars on Properties and Appointments (Leads already had one); appointment status badges + Lead Detail's "Unknown" fallback now translate with the FR/EN toggle; reply-to-lead from the dashboard (`POST /api/leads/:id/reply`, reuses `sendWhatsAppMessage`, not persisted to `conversations` by design); login page logo; **phone numbers unmasked everywhere** (Leads list, Lead Detail, Appointments — client decision, reverses the original masking rule).
- **Dashboard round 2 (bug fixes from live testing)** — a real search bug (word-token matching instead of whole-string matching, so a copy-pasted "Neighbourhood, City" string actually matches); Togo-timezone fix for appointment date/time display (`timeZone: 'UTC'` — was silently rendering in the *viewer's* browser timezone, a real scheduling-risk bug); "demain matin"-style vague dates now show a real date instead of blank, via `requested_date` / `requested_time_of_day` columns; property type labels on Appointments/Lead Detail (were showing the raw DB enum).
- **Property CRUD + media** — Add/Delete property from the dashboard (`POST /api/properties`, `DELETE /api/properties/:id`, **blocked with 409 if the listing has appointments** — `property_id` is `ON DELETE CASCADE`, so an unguarded delete would silently destroy booking history); in-app delete-confirmation modal (not `window.confirm`) naming the listing; multi-photo upload (loops the existing single-file endpoint); a full media lightbox with gallery navigation (arrow keys + on-screen ‹ › buttons) across photos + video; video support end-to-end (`video_url` column, Cloudinary video upload via `uploadVideo`/`deleteVideo` and the bulk script, `sendWhatsAppVideo()`, shown as a small clickable thumbnail on the dashboard, not full-width).
- **Automatic property description translation** — `description` is always the French source of truth everywhere else in the app; `description_en` is a cached one-time translation. New properties now get **both languages filled in immediately at creation**, regardless of which one the admin typed (a FR/EN toggle on the Add Property form tells the backend which side is authoritative; the other is machine-translated once via `utils/translate.js` and cached — never re-translated per page-view or per bot reply). The original 13 seed listings were backfilled the same way via `npm run backfill-translations` (re-runnable, only touches untranslated rows).
- **Appointment status control + Lead inline status** — appointments were read-only before; now `PATCH /api/appointments/:id/status` + a dropdown + status filter tabs (mirrors the Leads page pattern). Leads list also got an inline status `<select>` per row (previously only editable from the Lead Detail page).
- **Lead notes** — small auto-saving textarea on Lead Detail (`leads.notes` column, `PATCH /api/leads/:id/notes`, ~800ms debounce, separate from the WhatsApp transcript, never touched by the bot).
- **Live-ish conversation updates** — Lead Detail polls `GET /leads/:id` every 5s while the tab is visible (paused on `document.visibilitychange`), so a new WhatsApp message shows up without a manual refresh. No WebSocket infra was added — polling is the pragmatic fit for this stack. Careful merge logic so a poll never wipes out an admin's just-sent reply (which is local-only, not persisted — see above).
- **WhatsApp location sending** — `sendWhatsAppLocation()` built; `sendListingMedia()` (renamed from `sendListingPhotos`) now fans out photos → video (top listing only) → location pin per search result. Coordinates are still neighbourhood-level demo approximations, not exact addresses.
- **Full chatbot conversational rebuild** — this was the largest piece of work and deserves its own section below ("Conversational bot architecture"). Short version: the bot used to be stateless per message (no memory, hardcoded reply templates, a booking flow that silently destroyed itself on any off-script message) and is now context-aware, composes genuinely conversational replies via Claude while never letting the model author a fact, and survives interruptions (questions, photo requests, greetings, language-switch requests) mid-booking without losing state.
- **`npm run smoke-bot`** — a real regression suite (18 scenarios and counting) that drives the actual exported bot handlers against the DB with disposable leads. Exists because a static NLU test alone is not enough to catch a broken booking flow — see "Conversational bot architecture" for why this is mandatory to run after any bot change.

### ⏳ Actually pending
- **Location coordinates are neighbourhood-level approximations, not exact addresses.** Replace with real coordinates when the client supplies them.
- **Only 1 of 13 listings has a video** (Baguida villa) — the client has only sent one video file so far. The bot will only visibly demo video-sending if that specific listing comes up in a search.
- **Known minor debt, not fixed:** the frontend re-implements `formatXOF()`/`formatDate()` independently in 3 separate page files (properties, lead detail, appointments) instead of one shared utility — violates the spirit of the "one shared utility" rule below, which was written with only the backend's `utils/format.js` in mind. Worth consolidating into a `frontend/lib/format.js` next time one of those files is touched.

### ✅ Previously-pending items now resolved (don't re-flag these)
- **Railway migrations — RESOLVED, now automatic.** The long-standing "does Railway auto-run `migrate.js`?" question is answered: it did **not**. `start` was `node index.js`, and there is no `railway.json`/`nixpacks.toml`/`Procfile`/`Dockerfile`, so Nixpacks just ran `npm start` — every schema change up to this point reached production only because someone ran it by hand. `start` is now `node src/db/migrate.js && node index.js`, so **a plain redeploy migrates first**. Safe because `migrate.js` is fully idempotent; and because it exits non-zero on failure, a broken migration aborts the boot rather than serving new code against an old schema (verified both directions locally). `start:no-migrate` is kept for the rare case you want to boot without migrating. **Do not add a schema change without remembering this now runs on every deploy.**
- Real property photos ARE uploaded — 12 of 13 listings have real client photos (the 13th has a video instead). Uploaded via `npm run upload-photos` from `backend/photos-to-upload/<id>/`.
- `WHATSAPP_TOKEN` was expired (Graph API 190) — the client generated a fresh one. **Verified working** via a live, read-only Graph API call (not a message send) during this session.
- Admin login credentials (`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH`) — the client has set these. Login now works. (Still generated locally via `node backend/scripts/hash-password.js`, never pasted into a chat.)

### Key decisions made along the way — don't relitigate these
- `sendWhatsAppMessage()` / `sendWhatsAppImage()` / `sendWhatsAppVideo()` / `sendWhatsAppLocation()` all live in `webhookController.js`, **not** `utils/whatsapp.js` — the Code Rules section's literal wording ("exists once, in webhookController.js") was followed over the old file-structure sketch.
- Frontend wasn't scaffolded until Step 8 — Steps 1–7 were backend-only, on purpose.
- Contact number: kept the `agency_contact` column as-is rather than restructuring the schema — just seeded/backfilled one static value into every row. `backend/src/db/migrate.js` has an idempotent `UPDATE` for this.
- Dashboard language toggle is a separate, deliberately simpler mechanism than the bot's bilingual logic: plain `localStorage` + a small pub/sub hook (`frontend/lib/useDashboardLanguage.js`), no React Context, no i18n library. It only affects dashboard UI chrome — never the bot's replies or stored conversation content.
- Admin login redesign is login-screen-only — no users table, no roles, still one shared `ADMIN_TOKEN` session underneath. A real multi-user system was explicitly rejected; don't add one without being asked again.
- Bot caps photo-sending to the first 3 listings shown, max 2 photos each, to avoid flooding a WhatsApp chat with dozens of images on one search — adjustable via `MAX_LISTINGS_WITH_PHOTOS`/`MAX_PHOTOS_PER_LISTING` constants in `webhookController.js`. Video is capped further: only the #1-ranked listing, and only if it has one.
- Conversation-flow item 1 ("first message from a new number → welcome message") is implemented as a welcome *prefix* prepended to whatever the bot would say anyway, not a separate welcome-only turn — this answers the lead's first question immediately instead of making them repeat themselves.
- The NLU system prompt is built dynamically per call (`buildNluSystemPrompt()` in `webhookController.js`), injecting `propertyController.getKnownLocations()`'s live city/neighbourhood list — this is what lets a message naming only a neighbourhood ("Avédji") resolve correctly instead of being misread as a city.
- Phone numbers ARE sent to the frontend unmasked (Leads list, Lead Detail, Appointments) — client decision, overriding the original masking rule: the admin needs the real number to actually call/WhatsApp a lead back. `maskPhone()` still exists in `utils/format.js` but nothing calls it anymore.
- Reply-to-lead from the dashboard is deliberately **not** written to the `conversations` table — the admin's message is appended to the frontend's local state only (so it's visible in the UI immediately) but won't survive a page refresh. This was an explicit simplification, not an oversight.
- Property delete is blocked (409), not cascaded, when a property has appointments — an admin must not be able to silently destroy booking history via a UI delete button. There is no "force delete" escape hatch by design.
- Property description translation happens **once, at write time** (on create, or via the backfill script), never per page-view or per bot reply — a translate-on-read approach would add latency to every WhatsApp message and cost money per view for no benefit, since the text never changes after creation.
- Bot replies are composed by Claude, not hardcoded — see "Conversational bot architecture" below. This reverses the original "all bot strings hardcoded" rule; `BOT_STRINGS` is now the bilingual **fallback**, not the primary path.
- Language-switch detection uses **two mechanisms deliberately, not one**: a regex fast-path (`detectLanguageSwitchRequest`) for unambiguous phrasings, and an LLM-read `language_request` field for everything else. The regex-only version was tried first and found to be too brittle (missed "now please english", "please english", "english now") — this is documented so nobody "simplifies" it back down to one mechanism.

### Operational notes for whoever picks this up
- **This dev environment has a process-lingering quirk:** stopping the backend's background process often doesn't actually kill the underlying `node.exe` — always verify port 5000 is free (force-kill by PID if not) before restarting, or you'll silently talk to a stale process with old env vars. This has caused real confusion mid-session (a `curl` test against a "fresh" restart returned stale data because of this).
- `backend/.env` and `frontend/.env.local` hold real, live credentials (Supabase, Meta, Anthropic, Cloudinary, Resend). Never paste their values into a chat — variable *names* only, if asked.

---

## Ripple-effect rules — check EVERY time you add or change anything

These are the most common ways vibe-coded apps silently break.
After every change, ask yourself each of these before finishing:

- New backend route → register it in `backend/index.js`
- New controller function → export it in `module.exports` at the bottom of that file
- New env variable → add it to `.env.example` AND document it in this file under "Environment variables"
- New DB table or column → add `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE ADD COLUMN IF NOT EXISTS` in `backend/src/db/migrate.js`, then run migrations
- New dashboard page → add it to the dashboard nav links
- Any DB change → update every controller and frontend page that reads or writes that table
- **Any change to the bot's NLU schemas, composers, or booking-flow handlers → run `npm run smoke-bot` before considering it done.** See "Conversational bot architecture" for why this is non-negotiable, not optional polish.

---

## Code rules — no exceptions

### No duplicated business logic
- `sendWhatsAppMessage()` exists once, in `webhookController.js`. Import it everywhere else that needs it. Never copy-paste it.
- Property search/filter logic exists once, in `propertyController.js` (`searchProperties` for the dashboard's exact-match contract, `searchPropertiesWithFallback` for the bot's progressive-relaxation contract — both share one `buildQuery()` helper, so there is still only one query builder).
- Language detection exists once, in a shared utility. Never repeat it.
- XOF price formatting exists once, in a shared utility. Never repeat it.
- Property description translation exists once, in `utils/translate.js` (`translateToEnglish` / `translateToFrench`). Never call the Anthropic API directly for this elsewhere.

### Thin route handlers
Routes do one thing: receive the request, call a controller, return the response.
No business logic, no DB queries, no Claude API calls inside a route file.

BAD:
```js
app.post('/webhook', async (req, res) => {
  const result = await pool.query('SELECT ...');
  const aiReply = await anthropic.messages.create(...);
  res.sendStatus(200);
});
```

GOOD:
```js
app.post('/webhook', handleMessage); // handleMessage is in webhookController.js
```

### One DB query layer
All DB queries go in controller files. Never write `pool.query()` inside a route file or a frontend API call.

### No secrets in frontend
- Never put `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN`, `DATABASE_URL`, or `ADMIN_TOKEN` in any `NEXT_PUBLIC_` variable.
- Frontend only gets `NEXT_PUBLIC_API_URL`.

### No SELECT *
Always name the columns you need. Exception: internal admin queries where all columns are genuinely needed.

### Always use transactions for multi-step writes
If two or more DB rows must be written together (e.g. create lead + create conversation), wrap them in BEGIN/COMMIT. If one fails, ROLLBACK.

### Idempotent webhook handler
Meta retries webhook delivery. Before processing any incoming message, check if a message with the same `message.id` has already been processed. If yes, return 200 immediately without re-processing.

```js
const exists = await pool.query('SELECT id FROM processed_messages WHERE message_id = $1', [messageId]);
if (exists.rows.length > 0) return res.sendStatus(200);
```

### Input validation at every API boundary
Every POST/PATCH endpoint that the dashboard calls must validate required fields before touching the DB. Return 400 with a clear error if validation fails. Never trust frontend input.

### Server-side auth on every protected route
Every dashboard API route (leads, properties, appointments) must check the `ADMIN_TOKEN` before responding. The webhook route is the only exception (protected by Meta signature verification instead). `POST /api/auth/login` is the only dashboard-facing route also exempt — see Authentication below.

---

## Authentication — simple token, not Clerk

EXCELIA is a single-client deployment. No multi-tenant, no Clerk, no Razorpay, no users table, no roles.

Auth works like this:
- `ADMIN_TOKEN` is an env variable (a long random string) — this is still the ONLY session credential, exactly as originally designed.
- Login screen is username/password, not a pasted token: `POST /api/auth/login` checks `{ username, password }` against `ADMIN_USERNAME` + bcrypt `ADMIN_PASSWORD_HASH` (both env vars, **now set** by the client). This only changes *how the token is obtained* — on success the backend returns the same `ADMIN_TOKEN`, which the frontend stores in a cookie called `excelia_token` exactly as before. Generate the password hash locally with `node backend/scripts/hash-password.js` (masked stdin prompt) — never generate or paste a real password/hash into a Claude chat.
- Every backend API route protected by `authenticateAdmin` middleware:

```js
const authenticateAdmin = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
```

- Frontend `lib/api.js` reads `excelia_token` cookie and attaches as `Authorization: Bearer <token>` on every request.
- Never check auth in the frontend only. Always check on the backend.
- `POST /api/auth/login` is the one dashboard-facing route NOT behind `authenticateAdmin` — it's how the token is obtained in the first place, same exception pattern as the webhook route.

---

## WhatsApp message types — use the right one

Sending text:
```js
{ type: 'text', text: { body: message } }
```

Sending an image:
```js
{ type: 'image', image: { link: cloudinaryUrl, caption: optionalCaption } }
```

Sending a video:
```js
{ type: 'video', video: { link: cloudinaryUrl, caption: optionalCaption } }
```

Sending a location pin:
```js
{ type: 'location', location: { longitude, latitude, name: neighbourhood, address: city } }
```

Each message type is a separate API call. To send a listing: text card first, then one image call per photo, then video (top listing only), then location call. Never combine them into one API call.

**Status:** all four are built in `webhookController.js` — `sendWhatsAppMessage()`, `sendWhatsAppImage()`, `sendWhatsAppVideo()`, `sendWhatsAppLocation()`. `sendListingMedia()` (renamed from `sendListingPhotos`) fans them out per search result: photos (capped at `MAX_PHOTOS_PER_LISTING`, first `MAX_LISTINGS_WITH_PHOTOS` listings only), then video (top listing only, if it has one), then the location pin (every listing shown, if it has coordinates).

---

## Conversational bot architecture — read this whole section before touching the bot

The bot went through several rounds of real bugs found via live testing, and the architecture is now meaningfully different from a simple "extract filters → search → reply" pipeline. Understand this before changing anything in `webhookController.js`, `utils/replyComposer.js`, or `utils/language.js`.

### The lead profile is the bot's real memory (added in the rearchitecture)
`lead_profiles` (1:1 with `leads`, owned solely by `leadProfileController.js`) stores what the lead
actually wants as **structured data**: transaction, type, city/neighbourhood, bedroom range, budget +
stretch, purpose, timeline, liked/rejected property ids, last shown listings. It is written every turn
*before* the search runs, and the search filters come from the **profile**, not from the current
message — which is what lets "under 400000" search villas-in-Lomé-to-rent when the villa and the Lomé
were said ten messages ago.

**Rules that must not be broken here:**
- **The merge has THREE states, not two** (`mergeProfile`): not mentioned → keep; mentioned →
  overwrite; **explicitly retracted → NULL**. In JSON the first and third are both `null`, so the NLU
  reports retractions out of band via `cleared_fields`. Collapsing these turns the profile into a
  ratchet — a lead who says "forget the budget" keeps it forever and every later search silently
  excludes exactly what they asked for. There is a smoke scenario for precisely this.
- **There is exactly ONE memory of the requirement.** The old prompt instruction telling the model to
  re-read the transcript and repeat earlier values was **deleted** when the profile landed. Do not
  reintroduce it: the transcript sees a 10-row window and the profile sees everything, so once they
  disagree the re-derived (worse) value overwrites the stored one. The profile is injected into the
  NLU prompt as "what you already know"; the model reports only deltas.
- **`budget_stretch_max` is a number, never a boolean.** It becomes `price_ceiling`, an *absolute*
  ceiling that skips the 10% `PRICE_TOLERANCE` applied to `price_max` — the lead already told us their
  limit, so nudging it further shows them what they explicitly ruled out.
- Pending booking state expires after `PENDING_STATE_TTL_HOURS` (24h). The check is duplicated in
  `getOrCreateLead` and `getLeadState` and **they must stay identical** — routing reads one and the
  NLU-skip decision reads the other, so a mismatch would run a fresh search *and* route the reply into
  the booking handler.

### Decisions are made in code, not in a prompt (`utils/nextBestAction.js`)
An ordered list of rules, first match wins; the ordering **is** the goal hierarchy. Pure and
synchronous — no DB, no `await`, no `Date.now()` — which is what lets smoke-bot cover the whole
decision space instantly.

- **`protect_active_booking` is always rule #1.** Nothing outranks an in-progress booking, and the
  booking handlers remain the only code allowed to call `clearPendingAction`. This is the invariant
  that has broken twice; there is a smoke assertion that no intent can leak past it.
- Add behaviour by **inserting a rule**, not by growing a conditional. Every action must map to a
  distinct branch — if two intents produce the same action, they are one intent.
- Never extract a field nothing consumes. An unused schema field degrades extraction of the fields
  that matter (this is why emotion/objection are deferred until something branches on them).

### The bot has conversation memory
`getRecentConversation(leadId, 10)` (in `leadController.js`) reads the last 10 turns from `conversations` — the table was always being written to, but nothing read it back until this was added. It's fed into **both** the understanding call and every composer. Without this the bot was stateless per message and visibly broken:
- `"Thank you"` was classified as a greeting and answered with a full welcome message.
- `"Yes I want to book an appointment"` was rejected with *"I didn't quite catch that"*, because the selection NLU only accepted a bare number.
- `"under 400000"` after a search reset the filters instead of refining them (now it carries `city`/`type`/etc. forward and just adds the new constraint).
- A returning lead saying "Hi" got no greeting at all, just a question — the anti-repetition rule was too blunt (see below) and suppressed greetings entirely instead of just re-introductions.

**Rules to preserve:**
- **Never call an NLU or composer without passing `history`.** Every one of them takes it.
- Filters **carry forward** across turns — the NLU is instructed to repeat previously-stated values unless the lead changes their mind.
- The composer's `historyBlock()` forbids repeating a *sentence*, and forbids re-introducing yourself, but does **not** forbid greeting a returning lead back — that distinction matters (see the "Hi" bug above).
- When a mid-flow interruption happens (see below), the re-ask for whatever's still needed must be worded differently each time, not repeated verbatim — enforced via a `stillNeeded` hint passed into the relevant composer.

### The booking flow must survive off-script messages — this was the source of the worst bugs
Both booking-flow NLUs (`extractViewingSelection` for "which listing?", `extractAppointmentDateTime` for "what date/time?") originally offered only a tiny set of decisions (e.g. `datetime_given | decline`, `select | unclear`). **Every off-script message got forced into a bucket, and the wrong bucket was destructive:**
- "Can you share some photos?" while awaiting a date → classified `decline` → **silently cancelled the booking**.
- "What is the price again?" / "where is it located" → same, cancelled.
- "Hello" while awaiting a date → classified `datetime_given` → would have booked a viewing for the literal text "Hello", were it not for a `looksLikeDateText()` guard.
- "Hello" / "thanks" while choosing a listing → `unclear` → got a booking prompt instead of a normal reply.
- "Ok, 1 one I liked" → treated as a direct booking request and jumped straight to "what date and time?" — liking a property is not the same as asking to book it.

**The governing rule, now enforced: only an explicit refusal may clear pending booking state.** Both NLUs were widened to a full range of decisions so nothing off-script gets forced into `decline`:

- **Selection state** (`ViewingSelectionSchema.decision`): `select` (booking a specific one, or answering "which one?" with a bare choice), `express_interest` (liking one WITHOUT asking to book — confirms intent before asking for a date, narrows `pendingListingIds` to the one candidate so a following "yes" is unambiguous), `wants_to_book` (clear intent, no listing named), `new_search` (refining rather than choosing — drops booking state and re-searches, carrying filters forward), `request_media` (resends that listing's photos/video/location, stays in selection state), `question` (answered from the DB row, stays in selection state), `greeting` / `closing` (brief acknowledgement, stays in selection state), `decline`.
- **Datetime state** (`AppointmentDateTimeSchema.decision`): `datetime_given` (only when a real date/time was resolved — guarded by `looksLikeDateText()` so vague text can never become a stored viewing time), `request_media`, `question`, `greeting`, `closing`, `decline` (the only one that actually cancels). `handleViewingDateTimeReply` returns `{ text, mediaListings }` (not a bare string) precisely so a mid-datetime photo request can resend media without losing the booking.

**When adding a new decision type to either schema:** ask "does this need to end the booking?" — if the answer is no (and it almost always is), it must NOT map to `decline`, and the handler must return normally (keeping `pendingAction` set) rather than calling `clearPendingAction`.

### The composer never invents a fact or claims an action happened
Two hard rules baked into `BASE_PERSONA` in `utils/replyComposer.js`:
1. **No hallucinated property facts.** The model writes only the conversational wrapper (opening line, explanation of a widened search, follow-up question). Every price, neighbourhood, type, and the agency contact is rendered deterministically by `formatListingsBody()` and appended afterwards — the model is never given the ability to author a number.
2. **No claimed actions.** `BASE_PERSONA` explicitly forbids saying a viewing is booked/confirmed/registered, or that the team will call back, unless the calling code says so. This was a real bug found in testing: the composer would confidently say *"I'll let the team know... They'll confirm shortly!"* with **zero appointment rows in the database**, apparently improvising from conversation history showing the lead *asking* to book. There is a smoke-test check for exactly this (a lead asking to book with nothing shown must get no false confirmation).

### Language handling
- `detectLanguage(text)` — the original per-message FR/EN detector. Only trusted for **substantial** messages (>3 words); short replies and mid-booking-flow slot-fills reuse the lead's already-known language instead, since two-word detection is unreliable and was the original cause of language flip-flopping.
- The lead's `language` column is only ever updated via `COALESCE($1, language)` — passing `null` (e.g. for a media message, which carries no language signal) preserves the existing value instead of overwriting it. This fixed a real bug: sending one photo used to permanently flip an English conversation to French.
- **Explicit language-switch requests** ("in English please", "now please english", "en français svp") are detected by **two mechanisms, deliberately**: `detectLanguageSwitchRequest()` (regex, in `utils/language.js`) as a zero-cost fast path for unambiguous phrasings, and a `language_request` field on the main understanding call's schema for everything the regex misses (confirmed by testing to miss things like "now please english" and "please english"). Either one winning takes precedence over the pending-flow/short-message rule above and over normal detection. `composeLanguageSwitch()` composes the acknowledgement in the NEW language.

### The two NLU call sites
1. **Main understanding** (`extractSearchFilters`, despite the name — it now does much more): intent classification (`search`, `off_topic`, `greeting`, `closing`, `booking_intent`, `unclear`) plus `language_request`, `message_language` (replaces a separate `detectLanguage` call, so a message now costs 2 Claude calls instead of 3), and the search filters themselves (with carry-forward). Built dynamically per call via `buildNluSystemPrompt()`, injecting the live city/neighbourhood list.
2. **Booking-flow NLUs** — `extractViewingSelection` and `extractAppointmentDateTime`, both history-aware, both with the widened decision sets described above.

### `npm run smoke-bot` is mandatory after any bot change
`backend/scripts/smoke-bot.js` drives the **actual exported handlers** (`handleViewingSelectionReply`, `handleViewingDateTimeReply`, `extractSearchFilters`, etc.) through 18+ independent scenarios against the real DB, using disposable leads that are created and deleted per-scenario. It sends no WhatsApp messages.

**Why this exists, specifically:** an earlier verification pass re-implemented the handler logic inline in a test script instead of calling the real functions. The copy happened to have `history` in scope and passed, while the real `handleViewingSelectionReply` was throwing `ReferenceError: history is not defined` on *every* reply after a listing was shown — in production, every lead who replied to a listing set saw "Sorry, something went wrong." `node -c` cannot catch an undefined variable, and a reimplemented test proves nothing about the real code path. Every scenario asserts the resulting **pending state** (not just reply text), because a silently-cancelled booking is invisible if you only read what the bot said.

---

## Bilingual rules

- Detect language from the user's message using Claude (`detectLanguage`) for substantial messages; reuse the lead's stored language for short/mid-flow messages (see "Conversational bot architecture" above).
- Respond in the same language throughout the conversation, unless the lead explicitly asks to switch (see above) — then switch immediately and stay switched.
- **Bot replies are composed by Claude at send time** (`utils/replyComposer.js`), in the lead's language — this REVERSES the original "all bot strings hardcoded" rule, because the templated replies read as robotic to the client. `BOT_STRINGS` in `utils/language.js` is still the bilingual **fallback** used whenever a compose call fails, so a Claude outage degrades to the old behaviour instead of silence. Keep both FR and EN versions of every fallback string.
- **Hard boundary the composer must never cross:** it writes only the conversational wrapper. Every property fact is rendered deterministically by `formatListingsBody()` and appended afterwards. See "Conversational bot architecture" for the full list of composer rules (no hallucinated facts, no claimed actions, no verbatim-repeated questions).
- The `language` field is stored on the `leads` table and updated on every message that carries a reliable signal (see above for when it's preserved instead).
- This is entirely separate from the **dashboard's own FR/EN language toggle** (`frontend/lib/useDashboardLanguage.js`), which only controls the admin UI's chrome (nav labels, headings, etc.) for whoever is operating the dashboard — it never affects bot replies or stored conversation content.

---

## Database rules

- All schema changes go in `backend/src/db/migrate.js` using `IF NOT EXISTS`. Never edit production schema manually.
- Every table that will be queried by `organization` or `lead` must have an index on that foreign key column.
- The `properties` table is the single source of truth for listings. Seed it once with the 13 demo listings. Never hardcode listing data in bot prompts or frontend files.
- Prices are stored as integers in XOF. Never store as string. Format on display only.
- **Current columns beyond the original schema, all added via idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`:**
  - `properties.description_en` — cached one-time English translation (see "Property description translation" below).
  - `properties.video_url` — single optional walkthrough video URL (not a gallery like `photos`).
  - `appointments.requested_date` / `appointments.requested_time_of_day` — capture a resolvable date even when the exact clock time couldn't be determined ("demain matin"), without ever inventing a fake time. `requested_datetime` keeps its original strict meaning (exact datetime only).
  - `leads.notes` — free-text admin notes, separate from `conversations`, never touched by the bot.

---

## Property search logic

The bot extracts these fields from free text using Claude:
- `city` (e.g. Lomé, Noèpé)
- `neighbourhood` (e.g. Adidogomé, Avédji)
- `type` (chambre_salon, appartement, villa, terrain, mini_villa, appartement_meuble)
- `price_max` (integer in XOF)
- `bedrooms` (integer, nullable)

Two search functions in `propertyController.js`, sharing one `buildQuery()` helper (never duplicate the query logic):
- **`searchProperties(filters)`** — the dashboard/exact-match contract. Match on all provided fields (`ILIKE` for city/neighbourhood, exact for type/bedrooms, `price <= price_max * 1.1`). If no results, relax neighbourhood once and return the 3 closest. Kept simple and predictable for any future dashboard search UI.
- **`searchPropertiesWithFallback(filters)`** — what the **bot** actually uses. Never dead-ends: walks a relaxation cascade (drop neighbourhood → bedrooms → type → city → price, in that "least painful first" order) until something matches, and returns `{ listings, relaxed }` so the reply can honestly say what it had to widen instead of implying an exact match. This exists because the bot used to return zero results and a dead-end reply for entirely reasonable queries.

The Claude extraction prompt is built dynamically per call (`buildNluSystemPrompt()` in `webhookController.js`), injecting `propertyController.getKnownLocations()`'s live city/neighbourhood pairs, plus explicit market-vocabulary guidance (e.g. "1bhk"/"studio" → `chambre_salon` with 1 bedroom, never `appartement` — a real bug where this mapping was wrong caused a common query to return zero results).

---

## Property media (photos, video) and description translation

### Photos
- Dashboard: single-file upload (`POST /api/properties/:id/photos`) and **multi-file** upload (the frontend loops the same endpoint per file — no new backend endpoint needed). Click-to-enlarge lightbox with gallery navigation (arrow keys, ‹ › buttons, wraps at either end) across a listing's full photo+video set.
- Bulk: `backend/scripts/bulk-upload-photos.js` (`npm run upload-photos`) — drop files into `backend/photos-to-upload/<property_id>/`, run once. Deterministic Cloudinary public IDs mean re-running is safe (replaces, doesn't duplicate).

### Video
- One optional video per listing (`video_url`, not an array). Same upload pattern as photos: `POST/DELETE /api/properties/:id/video` (its own multer instance, 50MB limit vs photos' 10MB), and the bulk script also picks up one `.mp4/.mov/.webm` file per property folder.
- Shown on the dashboard as a small clickable thumbnail (not a full-width inline player) — click opens the lightbox.
- Sent by the bot only for the **top-ranked** search result, and only if it has one — a video is a much heavier WhatsApp attachment than a photo, so sending one per listing shown (like photos) would be disruptive.

### Description translation
`description` is authored in French and is the column read everywhere else in the app (bot replies, dashboard FR mode, search). `description_en` is a **cached, one-time** English translation — never generated at read time.
- `utils/translate.js` exports `translateToEnglish()` and `translateToFrench()` (same Claude model, shared glossary so translated copy stays consistent with `PROPERTY_TYPE_LABELS`). Both never throw — a failed translation just leaves the field null (EN mode falls back to French) rather than breaking anything.
- **On create**, the Add Property form has a FR/EN toggle for which language the admin actually typed. The backend translates whichever side wasn't typed and stores both immediately — so a new listing works correctly in both languages right away, not just after a manual backfill run.
- **Backfill**: `backend/scripts/backfill-translations.js` (`npm run backfill-translations`) — re-runnable, only touches properties where `description_en IS NULL` and appointments where `requested_date IS NULL` (it does double duty: also re-resolves old appointments' vague dates using their own `created_at` as the reference "now", since "demain" means nothing without the date it was said relative to).

---

## Conversation flow

1. First message from a new number → welcome message (FR or EN based on detected language) → ask what they are looking for. *(Implemented as a welcome prefix prepended to whatever the bot's actual reply would be — see "Key decisions" above — so a first message that already states a full search still gets answered immediately, not just greeted.)*
2. User describes requirement (free text) → Claude extracts fields (with conversation memory — see "Conversational bot architecture") → search → return matching listings.
3. Each listing sent as: text card (type, neighbourhood, price, agency contact) + photos + video (top listing only) + location pin. *(All built — see `sendListingMedia()`.)*
4. After listings: ask "Would you like to book a viewing?" (in their language, composed by Claude with the deterministic listing cards appended).
5. If yes → collect preferred date/time → save as appointment → confirm. This flow now survives interruptions (photo requests, questions, greetings) without losing the booking — see "Conversational bot architecture" for the full decision-handling rules.
6. Off-topic message → redirected in their language by the composer (fallback: "Je suis spécialisé dans la recherche immobilière au Togo.").
7. Every inbound message and every bot reply is saved to the `conversations` table — this is also the bot's short-term memory (see above), so never bypass `saveConversationMessage()`.

**Do not modify the booking flow, NLU schemas, or composers without reading "Conversational bot architecture" above in full and running `npm run smoke-bot` afterwards.**

---

## Dashboard admin features (built after Step 9)

- **Properties**: search bar, type-tab filter, Add (with FR/EN description toggle), Delete (in-app confirm modal, blocked with 409 if appointments exist), multi-photo upload, single video upload, media lightbox with gallery navigation.
- **Leads**: search bar, status pill-filter (existing), **inline status `<select>` per row** (new — previously only editable from Lead Detail), phone numbers shown in full.
- **Lead Detail**: status editor, conversation thread (polls every 5s while visible), reply-to-lead textarea (sends via WhatsApp, not persisted to `conversations`), notes textarea (auto-saves, persisted, separate system from the conversation), appointments panel with translated status.
- **Appointments**: search bar, status pill-filter, **status `<select>` per row** (new — previously read-only), Togo-timezone-correct date/time display, graceful display for vague requested times (falls back through: exact datetime → date + part-of-day → raw text).

All of the above follow the existing patterns already documented in "Code rules" (thin routes, `authenticateAdmin` on every route, validation at the boundary, no `SELECT *`).

---

## Mistakes to never make

- Never put all logic inside the webhook handler. It must only call controller functions.
- Never duplicate `sendWhatsAppMessage`. One copy, imported everywhere.
- Never store secrets in git. `.env` is in `.gitignore`. `.env.example` has placeholder values only.
- Never call Claude API synchronously for every single message without a try/catch. If Claude fails, the bot must still respond — return a graceful fallback message.
- Never trust that Meta will send a message only once. Always check idempotency.
- Never use `SELECT *` on the properties table when building bot responses. Select only the columns the bot needs.
- Never hardcode the 13 property listings anywhere except the seed script.
- Never write French/English bot strings in two different places. One object, two keys.
- Never run a migration without checking that it uses `IF NOT EXISTS` or `ADD COLUMN IF NOT EXISTS`.
- Never forget to add a new route to `backend/index.js`.
- Never forget to export a new function in `module.exports`.
- Never let the dashboard work without backend auth, even for the demo.
- Phone numbers ARE sent to the frontend unmasked (Leads list, Lead Detail, Appointments list) — client decision, overriding the original masking rule.
- **Never let a booking-flow NLU decision map to `decline` unless it is an actual, explicit refusal.** This was the root cause of the worst bug found in this project: questions and photo requests mid-booking were silently cancelling real leads' viewing appointments.
- **Never let the composer state or imply an action happened** (booked/confirmed/registered/"team will call") unless the calling code explicitly told it so — the model will otherwise confidently confirm things that were never written to the database.
- **Never translate a property description at read time.** Always write-time-only, cached in `description_en`.
- **Never skip `npm run smoke-bot` after touching the bot.** A syntax-valid, logically-plausible change to the booking flow has twice caused a silent production regression in this project that only a real end-to-end run against the actual handlers caught.

---

## Environment variables

Backend `.env` (never commit):
```
DATABASE_URL=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WEBHOOK_VERIFY_TOKEN=
ANTHROPIC_API_KEY=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
ADMIN_TOKEN=
ADMIN_USERNAME=
ADMIN_PASSWORD_HASH=
RESEND_API_KEY=
```

`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` are for the login screen (see Authentication above). Generate the hash with `node backend/scripts/hash-password.js` — never by hand, never in chat. **Now set** by the client; login works. `WHATSAPP_TOKEN` was expired earlier in the project and has since been refreshed by the client — verified working via a live API check.

No new environment variables were introduced by any of the work described in "Current build status" above — every new feature reuses `ANTHROPIC_API_KEY` (translation, NLU, composer) and the existing Cloudinary/WhatsApp credentials.

Frontend `.env.local` (never commit):
```
NEXT_PUBLIC_API_URL=http://localhost:5000
```

---

## File structure

This reflects what's actually built (not an aspirational sketch — keep it in sync as things change):

```
excelia/
├── CLAUDE.md
├── .gitignore
├── .claude/
│   └── launch.json                    ← dev server config for local preview tooling
├── backend/
│   ├── index.js                       ← Express app entry, route registration only
│   ├── .env                           ← Never commit
│   ├── .env.example                   ← Commit with placeholder values
│   ├── package.json
│   ├── scripts/
│   │   ├── bulk-upload-photos.js      ← uploads backend/photos-to-upload/<id>/ photos AND one video per folder to Cloudinary, updates DB
│   │   ├── hash-password.js           ← standalone CLI: masked password prompt, prints its bcrypt hash
│   │   ├── backfill-translations.js   ← re-runnable: fills properties.description_en + resolves old appointments' vague requested dates
│   │   └── smoke-bot.js               ← REQUIRED after any bot change: 18+ scenarios against the real handlers, disposable leads, no WhatsApp sends (npm run smoke-bot)
│   ├── photos-to-upload/              ← gitignored, local-only source images/video for the bulk script
│   └── src/
│       ├── db/
│       │   ├── index.js               ← PostgreSQL pool — has pool.on('error', ...) (required, see Mistakes)
│       │   ├── migrate.js             ← all schema changes AND idempotent data backfills
│       │   └── seed.js                ← 13 demo property listings
│       ├── middleware/
│       │   └── auth.js                ← authenticateAdmin middleware
│       ├── controllers/
│       │   ├── webhookController.js   ← WhatsApp inbound + ALL bot logic: NLU (extractSearchFilters/extractViewingSelection/extractAppointmentDateTime), booking-flow handlers, sendWhatsAppMessage/Image/Video/Location, sendListingMedia
│       │   ├── propertyController.js  ← searchProperties()/searchPropertiesWithFallback(), getKnownLocations(), create/remove, photo+video upload/delete — used by bot AND dashboard
│       │   ├── leadController.js      ← lead CRUD, getRecentConversation() (bot memory), booking pending-flow state, status pipeline, updateNotes, sendReply
│       │   ├── appointmentController.js ← booking logic, updateStatus
│       │   └── authController.js      ← login endpoint (username/password → ADMIN_TOKEN)
│       ├── routes/
│       │   ├── webhook.js
│       │   ├── properties.js          ← includes create/delete, photo upload/delete, video upload/delete endpoints
│       │   ├── leads.js               ← includes status PATCH, notes PATCH, reply POST
│       │   ├── appointments.js        ← includes status PATCH
│       │   └── auth.js
│       └── utils/
│           ├── cloudinary.js          ← shared Cloudinary config — bulk script + dashboard uploads both import this
│           ├── language.js            ← detectLanguage(), detectLanguageSwitchRequest() (regex fast-path), BOT_STRINGS (FR + EN fallbacks)
│           ├── translate.js           ← translateToEnglish()/translateToFrench() — write-time-only, cached, never called per page-view
│           ├── replyComposer.js       ← Claude-composed bot replies (see "Conversational bot architecture") — wrapper text only, never facts or claimed actions
│           └── format.js              ← formatXOF(), maskPhone() (unused now, phone is unmasked)
│
└── frontend/
    ├── .env.local
    ├── .gitignore
    ├── components/
    │   └── LanguageToggle.js          ← shared FR/EN pill, used by the dashboard nav AND the login page
    ├── lib/
    │   ├── api.js                     ← Axios instance with token from cookie
    │   ├── statusConfig.js            ← lead pipeline stages AND appointment statuses, bilingual labels
    │   ├── dashboardStrings.js        ← FR/EN dictionary for dashboard UI chrome
    │   └── useDashboardLanguage.js    ← localStorage-backed dashboard language hook
    └── app/
        ├── layout.js
        ├── page.js                    ← redirects to /login or /dashboard
        ├── globals.css
        ├── login/page.js              ← username/password login, client logo
        └── dashboard/
            ├── layout.js              ← nav, language toggle, auth guard
            ├── page.js                ← Leads overview: search, status filter, inline status dropdown per row
            ├── leads/[id]/page.js     ← Lead detail: status editor, live-polled conversation, reply-to-lead, notes (autosave)
            ├── properties/page.js     ← listings: search, type filter, Add/Delete, multi-photo + video upload, media lightbox
            └── appointments/page.js   ← search, status filter, status dropdown per row, timezone-correct dates
```

Note: there is no `dashboardController.js` — never needed. Every dashboard read/write lives directly in the controller that owns that resource (`leadController.js`, `propertyController.js`, `appointmentController.js`).

No new frontend page files were added by any of the dashboard work above — every feature was added to an existing page.

---

## How to work

1. Read this entire file before starting any task — start with "Current build status" above so you don't re-do finished work or miss what's actually still pending.
2. If the task touches the bot (`webhookController.js`, `utils/replyComposer.js`, `utils/language.js`, `propertyController.js`'s search functions), read "Conversational bot architecture" in full before writing any code — this codebase has already broken in the same class of way (a booking-flow NLU decision silently destroying state) more than once.
3. When adding a feature, identify ALL files it touches before writing any code.
4. After writing, check the ripple-effect list at the top.
5. **If you touched the bot, run `npm run smoke-bot` before considering the task done.** A syntax check is not enough — this exact class of bug (an undefined variable, or a booking flow that quietly cancels itself) has passed `node -c` and even a reimplemented test harness before.
6. One feature at a time. Do not start the next until the current one is complete.
7. If the saas-mvp repo has working code that covers a need, read it first before writing from scratch.
