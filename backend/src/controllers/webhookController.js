const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const Anthropic = require('@anthropic-ai/sdk');
// zodOutputFormat expects v4-shaped schemas — see note in utils/language.js.
const { z } = require('zod/v4');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const pool = require('../db/index');
const { searchProperties, getPropertyById } = require('./propertyController');
const {
    getOrCreateLead,
    getLeadState,
    saveConversationMessage,
    setPendingViewingSelection,
    setPendingViewingDatetime,
    clearPendingAction,
} = require('./leadController');
const { createAppointment } = require('./appointmentController');
const { detectLanguage, BOT_STRINGS, PROPERTY_TYPE_LABELS, DEFAULT_LANGUAGE } = require('../utils/language');
const { formatXOF } = require('../utils/format');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NLU_MODEL = 'claude-haiku-4-5-20251001';

// WhatsApp Cloud (Graph) API version — the ONE place it's set. Meta sunset
// v18.0 on 2026-01-26; every outbound send call (text now, image/location in
// Steps 4/5) must import this constant rather than hardcoding a version.
const GRAPH_API_VERSION = 'v22.0';

// ── Verify webhook ──
const verify = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        console.log('Webhook verified successfully');
        res.status(200).send(challenge);
    } else {
        console.log('Webhook verification failed');
        res.status(403).send('Forbidden');
    }
};

// ── Send WhatsApp message ──
const sendWhatsAppMessage = async (to, message) => {
    try {
        await axios.post(
            `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: message }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response?.data);
    }
};

// ── NLU: free text -> structured search filters ──
// Bot-specific free-text parsing — not reused by the dashboard (which will
// have its own explicit filter UI), so this lives here rather than in
// propertyController.js or a shared utils/ file, matching the same pattern
// already used for sendWhatsAppMessage.
const PROPERTY_TYPES = ['chambre_salon', 'appartement', 'villa', 'terrain', 'mini_villa', 'appartement_meuble'];

const NLUSchema = z.object({
    intent: z.enum(['search', 'off_topic', 'greeting', 'unclear']),
    city: z.string().nullable(),
    neighbourhood: z.string().nullable(),
    type: z.enum(PROPERTY_TYPES).nullable(),
    price_max: z.number().int().nullable(),
    bedrooms: z.number().int().nullable(),
});

const NLU_SYSTEM_PROMPT = `You are the natural-language-understanding engine for EXCELIA, a WhatsApp real estate chatbot for Togo. Read the incoming WhatsApp message (French or English — understand both) and classify it.

Field guidance:
- intent: "search" if the message expresses any interest in finding/renting/buying/viewing property, even with only one detail given (just a city, just a budget, etc). "off_topic" if clearly unrelated to real estate (weather, jokes, unrelated complaints, general chit-chat). "greeting" for pure greetings/small talk with zero property information ("Bonjour", "Hi", "Ça va ?"). "unclear" only if none of the above fit.
- city / neighbourhood: the place name as the user meant it, with accents restored if dropped (e.g. "lome" -> "Lomé"). null if not mentioned.
- type: map the user's wording to exactly one of these enum values — "chambre_salon" (single room / studio / "une chambre"), "appartement" (unfurnished apartment), "villa", "terrain" (land / "parcelle"), "mini_villa", "appartement_meuble" (furnished apartment / "meublé"). null if the type is not clearly one of these — never guess a value outside this list.
- price_max: the user's stated maximum budget as a plain integer number of XOF, with no currency symbol, spaces, or separators (e.g. "45000", "45 000 F CFA", "45k" -> 45000). Treat any stated budget as the maximum. null if no budget given.
- bedrooms: integer number of bedrooms/chambres mentioned. null if not mentioned.

Never fabricate a value you cannot support from the message. When genuinely uncertain about a field, use null rather than guessing.`;

const extractSearchFilters = async (text) => {
    const fallback = { intent: 'unclear', city: null, neighbourhood: null, type: null, price_max: null, bedrooms: null };
    if (!text || !text.trim()) return fallback;

    try {
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 400,
            temperature: 0,
            system: NLU_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: text }],
            output_config: { format: zodOutputFormat(NLUSchema) },
        });
        const parsed = response.parsed_output;
        if (!parsed) return fallback;

        // Defensive: collapse empty-string extraction to null.
        const cleanStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        return { ...parsed, city: cleanStr(parsed.city), neighbourhood: cleanStr(parsed.neighbourhood) };
    } catch (error) {
        console.error('NLU extraction failed:', error.message);
        // Claude failing must never break the bot — fall back gracefully.
        return fallback;
    }
};

const hasAnyFilter = (filters) =>
    Boolean(filters.city || filters.neighbourhood || filters.type || filters.price_max || filters.bedrooms);

// ── NLU: which listing (if any) did they pick for a viewing? ──
// The bot's booking prompt always numbers listings 1..N (formatListingsSummary
// already numbers them the same way), so the user naturally replies with a
// number — but may also decline, or describe the property instead of citing
// a number, so this still goes through Claude rather than a bare regex.
const ViewingSelectionSchema = z.object({
    decision: z.enum(['decline', 'select', 'unclear']),
    selected_number: z.number().int().nullable(),
});

const extractViewingSelection = async (text, listingCount) => {
    const fallback = { decision: 'unclear', selected_number: null };
    if (!text || !text.trim()) return fallback;

    try {
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 200,
            temperature: 0,
            system: `The user was just shown a numbered list of ${listingCount} real estate properties (numbered 1 to ${listingCount}) and asked if they'd like to book a viewing, replying either with the number of the property they want or declining. Classify their reply.
- decision: "decline" if they say no / not interested / not now. "select" if they clearly indicate exactly one property, by number or by an unambiguous description matching one listing's position in the list. "unclear" otherwise (e.g. they asked something unrelated instead of answering).
- selected_number: the 1-based number of the property they selected, only when decision is "select" — must be between 1 and ${listingCount}. null otherwise.`,
            messages: [{ role: 'user', content: text }],
            output_config: { format: zodOutputFormat(ViewingSelectionSchema) },
        });
        return response.parsed_output ?? fallback;
    } catch (error) {
        console.error('extractViewingSelection failed:', error.message);
        return fallback;
    }
};

// ── NLU: parse their preferred viewing date/time ──
// Always keeps the user's raw wording regardless of parse success — a
// booking is never blocked just because the exact time-of-day couldn't be
// resolved from free text. Also detects a change-of-mind at this stage.
const AppointmentDateTimeSchema = z.object({
    decision: z.enum(['datetime_given', 'decline']),
    iso_datetime: z.string().nullable(),
});

const extractAppointmentDateTime = async (text) => {
    const fallback = { decision: 'datetime_given', iso_datetime: null };
    if (!text || !text.trim()) return fallback;

    try {
        const now = new Date().toISOString();
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 200,
            temperature: 0,
            system: `The current date/time is ${now} (UTC). The user was just asked for their preferred date and time for a property viewing in Togo, and is replying in French or English, possibly with a relative expression ("demain", "next Friday at 3pm", "vendredi prochain").
- decision: "decline" only if they are now saying they've changed their mind and no longer want to book. Otherwise "datetime_given".
- iso_datetime: resolve their reply to an absolute ISO 8601 datetime (assume Togo's timezone, UTC+0) ONLY if you can confidently determine both a date and a time. If the date or time is too vague to resolve confidently (e.g. only a day of week with no time), return null rather than guessing — the raw text is kept regardless.`,
            messages: [{ role: 'user', content: text }],
            output_config: { format: zodOutputFormat(AppointmentDateTimeSchema) },
        });
        return response.parsed_output ?? fallback;
    } catch (error) {
        console.error('extractAppointmentDateTime failed:', error.message);
        return fallback;
    }
};

// ── Build a plain-text results summary ──
// Text only, by design — no photos or location pin. The client hasn't
// provided real property photos yet (seed data has empty photo arrays), so
// sending images/location is Step 4/5 work, not this step's. The properties
// table already has photos/latitude/longitude columns, so no schema change
// will be needed to wire those in later.
const formatListingsSummary = (listings, lang) => {
    const lines = listings.map((p, i) => {
        const typeLabel = PROPERTY_TYPE_LABELS[p.type]?.[lang] ?? p.type;
        const bedroomsLabel = lang === 'fr' ? 'chambre(s)' : 'bedroom(s)';
        const bedroomsPart = p.bedrooms ? ` · ${p.bedrooms} ${bedroomsLabel}` : '';
        const descriptionPart = p.description ? `\n${p.description}` : '';
        return `${i + 1}. ${typeLabel} — ${p.neighbourhood}, ${p.city}${bedroomsPart} — ${formatXOF(p.price)}${descriptionPart}\nContact: ${p.agency_contact}`;
    });
    return `${BOT_STRINGS.results_intro[lang]}\n\n${lines.join('\n\n')}`;
};

// ── Booking flow, step 1: which listing (or decline)? ──
const handleViewingSelectionReply = async ({ leadId, text, lang, pendingListingIds }) => {
    if (!pendingListingIds || pendingListingIds.length === 0) {
        // Defensive — shouldn't happen, but never get the lead stuck.
        await clearPendingAction(leadId);
        return BOT_STRINGS.welcome_clarify[lang];
    }

    const selection = await extractViewingSelection(text, pendingListingIds.length);

    if (selection.decision === 'decline') {
        await clearPendingAction(leadId);
        return BOT_STRINGS.booking_declined[lang];
    }

    if (
        selection.decision === 'select' &&
        Number.isInteger(selection.selected_number) &&
        selection.selected_number >= 1 &&
        selection.selected_number <= pendingListingIds.length
    ) {
        const propertyId = pendingListingIds[selection.selected_number - 1];
        await setPendingViewingDatetime(leadId, propertyId);
        return BOT_STRINGS.ask_datetime[lang];
    }

    // Unclear — keep the pending state as-is and ask again.
    return BOT_STRINGS.booking_selection_unclear[lang];
};

// ── Booking flow, step 2: their preferred date/time ──
const handleViewingDateTimeReply = async ({ leadId, propertyId, text, lang }) => {
    const result = await extractAppointmentDateTime(text);

    if (result.decision === 'decline') {
        await clearPendingAction(leadId);
        return BOT_STRINGS.booking_declined[lang];
    }

    await createAppointment({
        leadId,
        propertyId,
        requestedText: text,
        requestedDatetime: result.iso_datetime,
    });
    await clearPendingAction(leadId);

    const property = await getPropertyById(propertyId);
    const propertyLabel = property
        ? `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`
        : '';

    return `${BOT_STRINGS.booking_confirmed[lang]}\n${propertyLabel}\n${text}`;
};

// Sends the reply, saves it to the conversation log, and swallows its own
// errors (best-effort logging must never mask the original failure).
const replyAndLog = async (to, leadId, replyText) => {
    if (leadId) {
        try {
            await saveConversationMessage(leadId, 'bot', replyText);
        } catch (logError) {
            console.error('Failed to save bot reply to conversations:', logError.message);
        }
    }
    await sendWhatsAppMessage(to, replyText);
};

// ── Handle incoming message ──
const handleMessage = async (req, res) => {
    let to = null;
    let lang = DEFAULT_LANGUAGE;
    let leadId = null;

    try {
        const body = req.body || {};
        const value = body.entry?.[0]?.changes?.[0]?.value;
        const message = value?.messages?.[0];

        // No user message in this payload (e.g. a status/delivery-receipt
        // webhook) — nothing to do.
        if (!message) {
            return res.sendStatus(200);
        }

        const messageId = message.id;
        to = message.from;
        if (!messageId || !to) {
            return res.sendStatus(200);
        }

        // Idempotency — Meta retries webhook delivery. Never process (or
        // re-reply to) the same message twice.
        const existing = await pool.query('SELECT id FROM processed_messages WHERE message_id = $1', [messageId]);
        if (existing.rows.length > 0) {
            return res.sendStatus(200);
        }
        await pool.query(
            'INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING',
            [messageId]
        );

        const contactName = value?.contacts?.[0]?.profile?.name || null;
        const text = message.text?.body?.trim();

        // Non-text message (image, location, sticker, ...) — not handled yet,
        // but still a real contact: create/update the lead and log it. Left
        // untouched by the booking flow — a pending flow just stays pending.
        if (message.type !== 'text' || !text) {
            ({ id: leadId } = await getOrCreateLead(to, contactName, lang));
            await saveConversationMessage(leadId, 'user', `[unsupported message type: ${message.type}]`);
            await replyAndLog(to, leadId, BOT_STRINGS.unsupported_message_type[lang]);
            return res.sendStatus(200);
        }

        // Mid-booking-flow replies are often short slot-fills ("1", "oui",
        // "vendredi 15h") that aren't a reliable language signal on their
        // own — trust the lead's already-established language instead of
        // re-detecting and possibly flipping languages mid-conversation.
        // Otherwise (new lead, or no pending flow) detect fresh as usual.
        const existingLeadState = await getLeadState(to);
        lang = (existingLeadState && existingLeadState.pendingAction)
            ? existingLeadState.language
            : await detectLanguage(text);

        const lead = await getOrCreateLead(to, contactName, lang);
        leadId = lead.id;
        await saveConversationMessage(leadId, 'user', text);

        let replyBody;
        if (lead.pendingAction === 'awaiting_viewing_selection') {
            replyBody = await handleViewingSelectionReply({
                leadId,
                text,
                lang,
                pendingListingIds: lead.pendingListingIds,
            });
        } else if (lead.pendingAction === 'awaiting_viewing_datetime') {
            replyBody = await handleViewingDateTimeReply({
                leadId,
                propertyId: lead.pendingPropertyId,
                text,
                lang,
            });
        } else {
            const filters = await extractSearchFilters(text);

            if (filters.intent === 'off_topic') {
                replyBody = BOT_STRINGS.off_topic[lang];
            } else if (!hasAnyFilter(filters)) {
                // Bare greeting or nothing usable extracted — ask what they're
                // looking for rather than dumping every listing. Already a full
                // welcome on its own, so it never gets the welcome_prefix below.
                replyBody = BOT_STRINGS.welcome_clarify[lang];
            } else {
                const listings = await searchProperties({
                    city: filters.city,
                    neighbourhood: filters.neighbourhood,
                    type: filters.type,
                    price_max: filters.price_max,
                    bedrooms: filters.bedrooms,
                });
                if (listings.length === 0) {
                    replyBody = BOT_STRINGS.no_results[lang];
                } else {
                    // Offer a viewing booking and remember which listings
                    // were shown (in the same numbered order) so a reply
                    // like "2" can be resolved back to a specific property.
                    replyBody = `${formatListingsSummary(listings, lang)}\n\n${BOT_STRINGS.booking_prompt[lang]}`;
                    await setPendingViewingSelection(leadId, listings.map((p) => p.id));
                }
            }
        }

        // First-ever reply to a brand-new lead always opens with a welcome,
        // per CLAUDE.md's "first message from a new number → welcome
        // message" — but we still answer whatever they actually asked
        // rather than making them repeat themselves on a second turn.
        const isAlreadyAWelcome = replyBody === BOT_STRINGS.welcome_clarify[lang];
        const replyText = (lead.isNew && !isAlreadyAWelcome)
            ? `${BOT_STRINGS.welcome_prefix[lang]}\n\n${replyBody}`
            : replyBody;

        await replyAndLog(to, leadId, replyText);
        return res.sendStatus(200);
    } catch (error) {
        console.error('Error handling incoming message:', error);
        if (to) {
            try {
                await replyAndLog(to, leadId, BOT_STRINGS.error_fallback[lang]);
            } catch (sendError) {
                console.error('Fallback send also failed:', sendError.message);
            }
        }
        // Still 200 — the message is already marked processed; we don't want
        // Meta retrying it.
        return res.sendStatus(200);
    }
};

module.exports = {
    verify,
    sendWhatsAppMessage,
    handleMessage,
    extractSearchFilters,
    hasAnyFilter,
    formatListingsSummary,
    extractViewingSelection,
    extractAppointmentDateTime,
};
