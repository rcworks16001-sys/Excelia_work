# CLAUDE.md — EXCELIA Build Rules
# Read this entire file before writing any code. Follow every rule on every change.

---

## What you are building

EXCELIA — a WhatsApp AI real estate chatbot for OMEGA INTELLIGENTSIA GROUP, Togo.
Client: Antipas Komi Attisso.
Stack: Node.js + Express (Railway) | Next.js (Vercel) | PostgreSQL | Cloudinary | WhatsApp Cloud API | Claude (Anthropic) for NLU.
Languages: French and English (bilingual — detect per message, respond in same language).
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

## Current build status — read this first (last updated 2026-08-21)

**Repo:** https://github.com/rcworks16001-sys/Excelia_work, branch `main`, remote `origin`. Push only when explicitly asked — no standing auto-push rule.

### ✅ Done and pushed — do not re-build any of this
**Steps 1–9** (the numbered demo scope above) are all built, verified live, and pushed:
1. Backend skeleton + working webhook verify
2. Property search (`searchProperties()` in `propertyController.js`)
3. NLU (Claude-based free-text → structured filters)
4. Auto-send listing photos — bot sends photos when a listing has them (see photo-upload caveat below)
5. Auto-send listing location — **NOT built**, see Pending below (numbered here to match the original list, not because it's done)
6. Lead capture (`leads` + `conversations` tables)
7. Appointment booking (multi-turn WhatsApp flow + `appointments` table)
8. Admin dashboard — all four pages (leads, lead detail, properties, appointments)
9. Prospect pipeline (`leads.status`, dashboard filter/editor)

**Post-demo tasks 1–4** (requested after Step 9, separately from the numbered list above):
1. Property photo infrastructure — Cloudinary upload (bulk script + dashboard button), `sendWhatsAppImage()` wired into the bot's search-result replies
2. Contact number swap — every listing shows one static number (`+228 91062626 — EXCELIA office`) instead of the old per-listing placeholder
3. Dashboard language toggle — FR/EN switch for the admin UI itself, independent of the bot's own bilingual conversation logic
4. Username/password admin login — replaces the old token-paste screen; the `ADMIN_TOKEN` cookie session underneath is unchanged

**Bug fix:** the NLU couldn't resolve a bare neighbourhood name (e.g. "Avédji") without the city also being stated in the same message — fixed by injecting the DB's live city/neighbourhood list into the NLU prompt at call time.

All of the above is committed and pushed to `main` (latest relevant commit `9172ed3`).

### ⏳ Actually pending
- **Real property photos are not uploaded yet.** The upload *infrastructure* is done, but no real image files have been added to Cloudinary/the `photos` column — still waiting on the client. Once received: drop files into `backend/photos-to-upload/<property_id>/` and run `npm run upload-photos` (it prints the id → listing mapping), or use the dashboard's per-listing "Upload photo" button.
- **Location/map sending is not built at all.** `latitude`/`longitude` columns exist with approximate demo coordinates, but there is no `sendWhatsAppLocation()` and nothing sends a location message. Waiting on the client to send real map/neighbourhood links before building this.
- **Admin login has no credentials set.** `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` are blank in `.env` — the human user needs to run `node backend/scripts/hash-password.js` and set both themselves (never generate/paste real credentials into a Claude chat). The login screen rejects everyone until this is done.
- **`WHATSAPP_TOKEN` appears expired** — outbound sends fail with Graph API code 190 ("Authentication Error"). Needs a fresh token from the Meta developer app.
- **Unconfirmed: does Railway auto-run `migrate.js` on deploy?** If not, every future schema/data change needs `node src/db/migrate.js` run manually against production after pushing — this has been done manually each time so far.
- **Known minor debt, not fixed:** the frontend re-implements `formatXOF()`/`formatDate()` independently in 3 separate page files (properties, lead detail, appointments) instead of one shared utility — violates the spirit of the "one shared utility" rule below, which was written with only the backend's `utils/format.js` in mind. Worth consolidating into a `frontend/lib/format.js` next time one of those files is touched.

### Key decisions made along the way — don't relitigate these
- `sendWhatsAppMessage()` / `sendWhatsAppImage()` live in `webhookController.js`, **not** `utils/whatsapp.js` (the File Structure section below reflects this) — the Code Rules section's literal wording ("exists once, in webhookController.js") was followed over the old file-structure sketch.
- Frontend wasn't scaffolded until Step 8 — Steps 1–7 were backend-only, on purpose.
- Contact number: kept the `agency_contact` column as-is rather than restructuring the schema — just seeded/backfilled one static value into every row. `backend/src/db/migrate.js` has an idempotent `UPDATE` for this (necessary because `seed.js` skips re-seeding once the table has rows, so it alone never touches already-live data).
- Dashboard language toggle is a separate, deliberately simpler mechanism than the bot's bilingual logic: plain `localStorage` + a small pub/sub hook (`frontend/lib/useDashboardLanguage.js`), no React Context, no i18n library. It only affects dashboard UI chrome — never the bot's replies or stored conversation content.
- Admin login redesign is login-screen-only — no users table, no roles, still one shared `ADMIN_TOKEN` session underneath. A real multi-user system was explicitly rejected; don't add one without being asked again.
- Bot caps photo-sending to the first 3 listings shown, max 2 photos each, to avoid flooding a WhatsApp chat with dozens of images on one search — adjustable via `MAX_LISTINGS_WITH_PHOTOS`/`MAX_PHOTOS_PER_LISTING` constants in `webhookController.js`.
- Conversation-flow item 1 ("first message from a new number → welcome message") is implemented as a welcome *prefix* prepended to whatever the bot would say anyway, not a separate welcome-only turn — this answers the lead's first question immediately instead of making them repeat themselves. A stateless approximation was used since there's no reliable "is this genuinely their first-ever message" signal beyond the `leads` table itself.
- The NLU system prompt is now built dynamically per call (`buildNluSystemPrompt()` in `webhookController.js`), injecting `propertyController.getKnownLocations()`'s live city/neighbourhood list — it's no longer a static string.

### Operational notes for whoever picks this up
- **This dev environment has a process-lingering quirk:** stopping the backend's background process often doesn't actually kill the underlying `node.exe` — always verify port 5000 is free (force-kill by PID if not) before restarting, or you'll silently talk to a stale process with old env vars.
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

---

## Code rules — no exceptions

### No duplicated business logic
- `sendWhatsAppMessage()` exists once, in `webhookController.js`. Import it everywhere else that needs it. Never copy-paste it.
- Property search/filter logic exists once, in `propertyController.js`. The bot and the dashboard both call the same function.
- Language detection exists once, in a shared utility. Never repeat it.
- XOF price formatting exists once, in a shared utility. Never repeat it.

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
Every dashboard API route (leads, properties, appointments) must check the `ADMIN_TOKEN` before responding. The webhook route is the only exception (protected by Meta signature verification instead).

---

## Authentication — simple token, not Clerk

EXCELIA is a single-client deployment. No multi-tenant, no Clerk, no Razorpay, no users table, no roles.

Auth works like this:
- `ADMIN_TOKEN` is an env variable (a long random string) — this is still the ONLY session credential, exactly as originally designed.
- **Login screen (as of Task 4) is username/password**, not a pasted token: `POST /api/auth/login` checks `{ username, password }` against `ADMIN_USERNAME` + bcrypt `ADMIN_PASSWORD_HASH` (both env vars). This only changes *how the token is obtained* — on success the backend returns the same `ADMIN_TOKEN`, which the frontend stores in a cookie called `excelia_token` exactly as before. Generate the password hash locally with `node backend/scripts/hash-password.js` (masked stdin prompt) — never generate or paste a real password/hash into a Claude chat.
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

Sending a location pin:
```js
{ type: 'location', location: { longitude, latitude, name: neighbourhood, address: city } }
```

Each message type is a separate API call. To send a listing: text card first, then one image call per photo, then location call. Never combine them into one API call.

**Status:** text and image sending are both built (`sendWhatsAppMessage()`, `sendWhatsAppImage()` in `webhookController.js`). Location sending is **not built** — no `sendWhatsAppLocation()` exists yet; waiting on the client to send real map/neighbourhood links first.

---

## Bilingual rules

- Detect language from the user's message using Claude.
- Respond in the same language throughout the conversation.
- If the user switches language mid-conversation, switch with them immediately.
- All Claude prompts for NLU must instruct the model to respond in French if the input is French, English if English.
- Bot messages (welcome, no-results, off-topic redirect) must have both FR and EN versions hardcoded. Never ask Claude to translate static bot strings.
- The `language` field is stored on the `leads` table and updated every message.
- This is entirely separate from the **dashboard's own FR/EN language toggle** (`frontend/lib/useDashboardLanguage.js`), which only controls the admin UI's chrome (nav labels, headings, etc.) for whoever is operating the dashboard — it never affects bot replies or stored conversation content, and doesn't touch this section's rules at all.

---

## Database rules

- All schema changes go in `backend/src/db/migrate.js` using `IF NOT EXISTS`. Never edit production schema manually.
- Every table that will be queried by `organization` or `lead` must have an index on that foreign key column.
- The `properties` table is the single source of truth for listings. Seed it once with the 13 demo listings. Never hardcode listing data in bot prompts or frontend files.
- Prices are stored as integers in XOF. Never store as string. Format on display only.

---

## Property search logic

The bot extracts these fields from free text using Claude:
- `city` (e.g. Lomé, Noèpé)
- `neighbourhood` (e.g. Adidogomé, Avédji)
- `type` (chambre_salon, appartement, villa, terrain, mini_villa, appartement_meuble)
- `price_max` (integer in XOF)
- `bedrooms` (integer, nullable)

Search query: match on all provided fields. Use `ILIKE` for city/neighbourhood (fuzzy text). Exact match for type and bedrooms. Price: `price <= price_max * 1.1` (10% tolerance).

If no results: return the 3 closest listings (relax neighbourhood constraint, keep type and price).
If still no results: tell the user in their language, ask one clarifying question.

This logic lives in ONE function: `searchProperties(filters)` in `propertyController.js`. Both the bot and any future dashboard search call this same function.

The Claude extraction prompt is built dynamically per call (`buildNluSystemPrompt()` in `webhookController.js`), injecting `propertyController.getKnownLocations()`'s live city/neighbourhood pairs — this is what lets a message naming only a neighbourhood ("Avédji") resolve correctly instead of being misread as a city.

---

## Conversation flow

1. First message from a new number → welcome message (FR or EN based on detected language) → ask what they are looking for. *(Implemented as a welcome prefix prepended to whatever the bot's actual reply would be — see "Key decisions" above — so a first message that already states a full search still gets answered immediately, not just greeted.)*
2. User describes requirement (free text) → Claude extracts fields → search → return matching listings.
3. Each listing sent as: text card (type, neighbourhood, price, agency contact) + photos + location pin. *(Photos: built. Location pin: not built yet — see "WhatsApp message types" above.)*
4. After listings: ask "Would you like to book a viewing?" (in their language).
5. If yes → collect preferred date/time → save as appointment → confirm.
6. Off-topic message → redirect in their language: "Je suis spécialisé dans la recherche immobilière au Togo."
7. Every inbound message and every bot reply is saved to the `conversations` table.

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
- Never send a user's WhatsApp number to the frontend. Mask it or omit it in API responses.

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

`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` are for the login screen (see Authentication above). Generate the hash with `node backend/scripts/hash-password.js` — never by hand, never in chat. Currently blank in the live `.env` — login won't work until the human user sets them.

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
│   │   ├── bulk-upload-photos.js      ← one-time/repeatable: uploads backend/photos-to-upload/<id>/ to Cloudinary, updates DB
│   │   └── hash-password.js           ← standalone CLI: masked password prompt, prints its bcrypt hash
│   ├── photos-to-upload/              ← gitignored, local-only source images for the bulk script
│   └── src/
│       ├── db/
│       │   ├── index.js               ← PostgreSQL pool — has pool.on('error', ...) (required, see Mistakes)
│       │   ├── migrate.js             ← all schema changes AND idempotent data backfills
│       │   └── seed.js                ← 13 demo property listings
│       ├── middleware/
│       │   └── auth.js                ← authenticateAdmin middleware
│       ├── controllers/
│       │   ├── webhookController.js   ← WhatsApp inbound + ALL bot logic (NLU, booking flow, sendWhatsAppMessage/Image)
│       │   ├── propertyController.js  ← searchProperties(), getKnownLocations(), photo upload/delete — used by bot AND dashboard
│       │   ├── leadController.js      ← lead CRUD + booking pending-flow state + status pipeline
│       │   ├── appointmentController.js ← booking logic
│       │   └── authController.js      ← login endpoint (username/password → ADMIN_TOKEN)
│       ├── routes/
│       │   ├── webhook.js
│       │   ├── properties.js          ← includes photo upload/delete endpoints
│       │   ├── leads.js               ← includes the status PATCH endpoint
│       │   ├── appointments.js
│       │   └── auth.js
│       └── utils/
│           ├── cloudinary.js          ← shared Cloudinary config — bulk script + dashboard uploads both import this
│           ├── language.js            ← detectLanguage(), BOT_STRINGS (FR + EN)
│           └── format.js              ← formatXOF(), maskPhone()
│
└── frontend/
    ├── .env.local
    ├── .gitignore
    ├── components/
    │   └── LanguageToggle.js          ← shared FR/EN pill, used by the dashboard nav AND the login page
    ├── lib/
    │   ├── api.js                     ← Axios instance with token from cookie
    │   ├── statusConfig.js            ← lead pipeline stages, bilingual labels
    │   ├── dashboardStrings.js        ← FR/EN dictionary for dashboard UI chrome
    │   └── useDashboardLanguage.js    ← localStorage-backed dashboard language hook
    └── app/
        ├── layout.js
        ├── page.js                    ← redirects to /login or /dashboard
        ├── globals.css
        ├── login/page.js              ← username/password login
        └── dashboard/
            ├── layout.js              ← nav, language toggle, auth guard
            ├── page.js                ← Leads overview
            ├── leads/[id]/page.js     ← Lead detail + conversation + status editor
            ├── properties/page.js     ← 13 listings + photo upload/delete UI
            └── appointments/page.js
```

Note: there is no `dashboardController.js` — never needed. Every dashboard read/write lives directly in the controller that owns that resource (`leadController.js`, `propertyController.js`, `appointmentController.js`).

---

## How to work

1. Read this entire file before starting any task — start with "Current build status" above so you don't re-do finished work or miss what's actually still pending.
2. When adding a feature, identify ALL files it touches before writing any code.
3. After writing, check the ripple-effect list at the top.
4. One feature at a time. Do not start the next until the current one is complete.
5. If the saas-mvp repo has working code that covers a need, read it first before writing from scratch.
