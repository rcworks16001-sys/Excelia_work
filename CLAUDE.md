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

EXCELIA is a single-client deployment. No multi-tenant, no Clerk, no Razorpay.

Auth works like this:
- `ADMIN_TOKEN` is an env variable (a long random string).
- Dashboard login page: user enters the token → stored in a cookie called `excelia_token`.
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

---

## Bilingual rules

- Detect language from the user's message using Claude.
- Respond in the same language throughout the conversation.
- If the user switches language mid-conversation, switch with them immediately.
- All Claude prompts for NLU must instruct the model to respond in French if the input is French, English if English.
- Bot messages (welcome, no-results, off-topic redirect) must have both FR and EN versions hardcoded. Never ask Claude to translate static bot strings.
- The `language` field is stored on the `leads` table and updated every message.

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

---

## Conversation flow

1. First message from a new number → welcome message (FR or EN based on detected language) → ask what they are looking for.
2. User describes requirement (free text) → Claude extracts fields → search → return matching listings.
3. Each listing sent as: text card (type, neighbourhood, price, agency contact) + photos + location pin.
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
RESEND_API_KEY=
```

Frontend `.env.local` (never commit):
```
NEXT_PUBLIC_API_URL=http://localhost:5000
```

---

## File structure

```
excelia/
├── backend/
│   ├── index.js                  ← Express app entry, route registration only
│   ├── .env                      ← Never commit
│   ├── .env.example              ← Commit with placeholder values
│   └── src/
│       ├── db/
│       │   ├── index.js          ← PostgreSQL pool
│       │   ├── migrate.js        ← All schema changes
│       │   └── seed.js           ← 13 demo property listings
│       ├── middleware/
│       │   └── auth.js           ← authenticateAdmin middleware
│       ├── controllers/
│       │   ├── webhookController.js   ← WhatsApp inbound + bot logic
│       │   ├── propertyController.js  ← searchProperties() — used by bot AND dashboard
│       │   ├── leadController.js      ← lead CRUD
│       │   ├── appointmentController.js ← booking logic
│       │   └── dashboardController.js   ← dashboard stats
│       ├── routes/
│       │   ├── webhook.js
│       │   ├── properties.js
│       │   ├── leads.js
│       │   └── appointments.js
│       └── utils/
│           ├── whatsapp.js       ← sendWhatsAppMessage(), sendWhatsAppImage(), sendWhatsAppLocation()
│           ├── language.js       ← detectLanguage(), BOT_STRINGS (FR + EN)
│           └── format.js         ← formatXOF(), formatDate()
│
└── frontend/
    ├── app/
    │   ├── login/page.js         ← Token login page
    │   ├── dashboard/
    │   │   ├── page.js           ← Leads overview
    │   │   ├── leads/[id]/page.js ← Lead detail + conversation
    │   │   ├── properties/page.js ← 13 listings view
    │   │   └── appointments/page.js ← Booking calendar
    │   └── globals.css
    ├── lib/
    │   └── api.js                ← Axios instance with token from cookie
    └── .env.local
```

---

## How to work

1. Read this entire file before starting any task.
2. When adding a feature, identify ALL files it touches before writing any code.
3. After writing, check the ripple-effect list at the top.
4. One feature at a time. Do not start the next until the current one is complete.
5. If the saas-mvp repo has working code that covers a need, read it first before writing from scratch.
