const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
// zodOutputFormat expects v4-shaped schemas — see note in utils/language.js.
const { z } = require('zod/v4');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const pool = require('../db/index');
const { searchPropertiesWithFallback, getPropertyById, getKnownLocations } = require('./propertyController');
const {
    composeResultsIntro,
    composeNoResults,
    composeGreeting,
    composeOffTopic,
    composeUnsupportedMedia,
    composeLanguageSwitch,
} = require('../utils/replyComposer');
const {
    getOrCreateLead,
    getLeadState,
    saveConversationMessage,
    setPendingViewingSelection,
    setPendingViewingDatetime,
    clearPendingAction,
} = require('./leadController');
const { createAppointment } = require('./appointmentController');
const {
    detectLanguage, detectLanguageSwitchRequest, BOT_STRINGS, PROPERTY_TYPE_LABELS, DEFAULT_LANGUAGE,
} = require('../utils/language');
const { formatXOF } = require('../utils/format');

// Cloudinary config lives in utils/cloudinary.js now (shared with the bulk
// upload script and propertyController's photo endpoints). Nothing in this
// file calls the Cloudinary SDK directly — sending a photo just needs the
// already-hosted URL — so no import needed here.

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
// Returns true/false so callers that need to know (e.g. the admin dashboard's
// reply-to-lead endpoint) can report success/failure. Still never throws —
// the bot's own inbound-message handling must keep working even if a send
// fails, so the error is caught and logged here either way.
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
        return true;
    } catch (error) {
        console.error('Error sending WhatsApp message:', error.response?.data);
        return false;
    }
};

// ── Send WhatsApp image ──
// Per CLAUDE.md's WhatsApp message-type reference: each message type is its
// own API call — this never gets combined with the text card into one call.
const sendWhatsAppImage = async (to, imageUrl, caption) => {
    try {
        await axios.post(
            `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'image',
                image: { link: imageUrl, caption }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Error sending WhatsApp image:', error.response?.data);
    }
};

// ── Send WhatsApp video ──
// Same shape as sendWhatsAppImage — own message-type-per-call, per CLAUDE.md.
const sendWhatsAppVideo = async (to, videoUrl, caption) => {
    try {
        await axios.post(
            `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'video',
                video: { link: videoUrl, caption }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Error sending WhatsApp video:', error.response?.data);
    }
};

// ── Send WhatsApp location pin ──
// Same message-type-per-call rule as image/video. Coordinates on the listings
// are neighbourhood-level approximations, not exact street addresses — the
// pin shows the area, which is what a lead needs before booking a viewing.
const sendWhatsAppLocation = async (to, latitude, longitude, name, address) => {
    try {
        await axios.post(
            `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'location',
                location: { latitude, longitude, name, address }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Error sending WhatsApp location:', error.response?.data);
    }
};

// Sends photos for a shown listing (if it has any) and logs each send to the
// conversation transcript. Capped — sending every photo for every listing
// shown would flood the chat (up to 10 listings can be returned at once).
const MAX_LISTINGS_WITH_PHOTOS = 3;
const MAX_PHOTOS_PER_LISTING = 2;

const sendListingMedia = async (to, leadId, listings, lang) => {
    const listingsToPhotograph = listings.slice(0, MAX_LISTINGS_WITH_PHOTOS);

    for (let i = 0; i < listingsToPhotograph.length; i += 1) {
        const listing = listingsToPhotograph[i];
        const typeLabel = PROPERTY_TYPE_LABELS[listing.type]?.[lang] ?? listing.type;

        if (listing.photos && listing.photos.length > 0) {
            const photosToSend = listing.photos.slice(0, MAX_PHOTOS_PER_LISTING);
            for (const photoUrl of photosToSend) {
                const caption = `${i + 1}. ${typeLabel} — ${listing.neighbourhood}`;
                await sendWhatsAppImage(to, photoUrl, caption);
                try {
                    await saveConversationMessage(leadId, 'bot', `[photo sent: ${photoUrl}]`);
                } catch (logError) {
                    console.error('Failed to log photo send to conversations:', logError.message);
                }
            }
        }

        // Video only for the #1-ranked listing, and only if it has one — a
        // walkthrough video is a much heavier attachment than a photo, so
        // sending one per listing shown (like photos) would be disruptive.
        if (i === 0 && listing.video_url) {
            const caption = `${i + 1}. ${typeLabel} — ${listing.neighbourhood}`;
            await sendWhatsAppVideo(to, listing.video_url, caption);
            try {
                await saveConversationMessage(leadId, 'bot', `[video sent: ${listing.video_url}]`);
            } catch (logError) {
                console.error('Failed to log video send to conversations:', logError.message);
            }
        }

        // Location pin last, so the lead sees what the place looks like
        // before where it is. Only when the listing actually has coordinates.
        if (listing.latitude != null && listing.longitude != null) {
            await sendWhatsAppLocation(
                to,
                listing.latitude,
                listing.longitude,
                `${typeLabel} — ${listing.neighbourhood}`,
                `${listing.neighbourhood}, ${listing.city}`
            );
            try {
                await saveConversationMessage(leadId, 'bot', `[location sent: ${listing.neighbourhood}, ${listing.city}]`);
            } catch (logError) {
                console.error('Failed to log location send to conversations:', logError.message);
            }
        }
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

// Builds the NLU system prompt, optionally injecting the list of known
// cities/neighbourhoods so Claude can tell a bare neighbourhood name
// ("Avédji") apart from a city name instead of guessing — without this list,
// a message that only names a neighbourhood (no city) got misclassified as
// { city: "Avedji", neighbourhood: null }, and the search then found nothing
// even though a matching listing existed. knownLocations is
// [{ city, neighbourhood }, ...] from propertyController.getKnownLocations();
// pass [] to fall back to the plain prompt (e.g. if that query fails).
const buildNluSystemPrompt = (knownLocations = []) => {
    const neighbourhoodsByCity = {};
    for (const { city, neighbourhood } of knownLocations) {
        if (!city || !neighbourhood) continue;
        if (!neighbourhoodsByCity[city]) neighbourhoodsByCity[city] = [];
        if (!neighbourhoodsByCity[city].includes(neighbourhood)) {
            neighbourhoodsByCity[city].push(neighbourhood);
        }
    }
    const locationLines = Object.entries(neighbourhoodsByCity)
        .map(([city, neighbourhoods]) => `- ${city}: ${neighbourhoods.join(', ')}`)
        .join('\n');

    const locationGuidance = locationLines
        ? `\n\nKnown cities and their neighbourhoods currently in our listings — use this to tell a neighbourhood apart from a city (a name listed under a city below is a NEIGHBOURHOOD, not a city, even if the message doesn't mention the city at all):\n${locationLines}\n\nIf the message names a neighbourhood from this list, set "neighbourhood" to it and set "city" to the city it's listed under, even if the user didn't say the city. If a place name isn't in this list, use your best judgment.`
        : '';

    return `You are the natural-language-understanding engine for EXCELIA, a WhatsApp real estate chatbot for Togo. Read the incoming WhatsApp message (French or English — understand both) and classify it.

Field guidance:
- intent: "search" if the message expresses any interest in finding/renting/buying/viewing property, even with only one detail given (just a city, just a budget, etc). "off_topic" if clearly unrelated to real estate (weather, jokes, unrelated complaints, general chit-chat). "greeting" for pure greetings/small talk with zero property information ("Bonjour", "Hi", "Ça va ?"). "unclear" only if none of the above fit.
- city / neighbourhood: the place name as the user meant it, with accents restored if dropped (e.g. "lome" -> "Lomé"). null if not mentioned.${locationGuidance}
- type: map the user's wording to exactly one of these enum values — "chambre_salon" (single room / studio / "une chambre"), "appartement" (unfurnished apartment), "villa", "terrain" (land / "parcelle"), "mini_villa", "appartement_meuble" (furnished apartment / "meublé"). null if the type is not clearly one of these — never guess a value outside this list.
  Vocabulary customers actually use, and what it maps to here:
  * "1bhk", "1 BHK", "studio", "single room", "one room", "chambre salon" -> type "chambre_salon", bedrooms 1. (In this market a one-bedroom home is a "chambre salon", NOT a one-bedroom "appartement" — never map these to "appartement".)
  * "2bhk"/"3bhk" and similar -> "appartement" with bedrooms 2/3 respectively.
  * "meublé", "furnished" -> "appartement_meuble".
  * "parcelle", "plot", "land", "terrain nu" -> "terrain".
  If the customer's wording implies a size but NOT a building type (e.g. just "something small", "2 bedrooms"), set bedrooms and leave type null rather than guessing a type.
- price_max: the user's stated maximum budget as a plain integer number of XOF, with no currency symbol, spaces, or separators (e.g. "45000", "45 000 F CFA", "45k" -> 45000). Treat any stated budget as the maximum. null if no budget given.
- bedrooms: integer number of bedrooms/chambres mentioned. null if not mentioned.

Never fabricate a value you cannot support from the message. When genuinely uncertain about a field, use null rather than guessing.`;
};

const extractSearchFilters = async (text) => {
    const fallback = { intent: 'unclear', city: null, neighbourhood: null, type: null, price_max: null, bedrooms: null };
    if (!text || !text.trim()) return fallback;

    let knownLocations = [];
    try {
        knownLocations = await getKnownLocations();
    } catch (error) {
        console.error('Failed to fetch known locations for NLU prompt, proceeding without them:', error.message);
    }

    try {
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 400,
            temperature: 0,
            system: buildNluSystemPrompt(knownLocations),
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
    resolved_date: z.string().nullable(),
    time_of_day: z.enum(['morning', 'afternoon', 'evening']).nullable(),
});

// `now` is injectable so the backfill script can re-resolve an OLD booking
// using the date it was actually made — "demain" means nothing without the
// reference point it was said relative to.
const extractAppointmentDateTime = async (text, referenceNow = null) => {
    const fallback = { decision: 'datetime_given', iso_datetime: null, resolved_date: null, time_of_day: null };
    if (!text || !text.trim()) return fallback;

    try {
        const now = (referenceNow ? new Date(referenceNow) : new Date()).toISOString();
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 200,
            temperature: 0,
            system: `The current date/time is ${now} (UTC). The user was just asked for their preferred date and time for a property viewing in Togo, and is replying in French or English, possibly with a relative expression ("demain", "next Friday at 3pm", "vendredi prochain").
- decision: "decline" only if they are now saying they've changed their mind and no longer want to book. Otherwise "datetime_given".
- iso_datetime: resolve their reply to an absolute ISO 8601 datetime (assume Togo's timezone, UTC+0) ONLY if you can confidently determine both a date AND a specific clock time. If the time is vague ("matin", "morning", "dans la journée"), return null here — use resolved_date + time_of_day instead. Never invent a clock time.
- resolved_date: the calendar date they mean, as "YYYY-MM-DD" (Togo time, UTC+0), whenever the DATE is determinable — including relative expressions ("demain" -> the day after the current date above, "vendredi" -> the next upcoming Friday). Fill this in even when you also filled iso_datetime, and even when the time of day is unknown. null only if no date can be determined at all.
- time_of_day: "morning", "afternoon", or "evening" if they indicated a coarse part of the day ("matin", "après-midi", "le soir"). If they gave a specific clock time instead, still classify it (e.g. 15h -> "afternoon"). null if there is no time indication whatsoever.`,
            messages: [{ role: 'user', content: text }],
            output_config: { format: zodOutputFormat(AppointmentDateTimeSchema) },
        });
        return response.parsed_output ?? fallback;
    } catch (error) {
        console.error('extractAppointmentDateTime failed:', error.message);
        return fallback;
    }
};

// ── Build the numbered listing cards ──
// EVERY property fact the lead sees is rendered here, deterministically from
// the DB row. The conversational layer (utils/replyComposer.js) only writes
// the sentence that sits above these cards — it never authors a price,
// neighbourhood or contact, so those can't be model-invented.
const formatListingsBody = (listings, lang) => {
    const lines = listings.map((p, i) => {
        const typeLabel = PROPERTY_TYPE_LABELS[p.type]?.[lang] ?? p.type;
        const bedroomsLabel = lang === 'fr' ? 'chambre(s)' : 'bedroom(s)';
        const bedroomsPart = p.bedrooms ? ` · ${p.bedrooms} ${bedroomsLabel}` : '';
        // Descriptions are authored in French; description_en is the cached
        // one-time translation. Falls back to French if a listing hasn't been
        // translated yet, so an English lead still gets the details.
        const description = lang === 'en' ? (p.description_en || p.description) : p.description;
        const descriptionPart = description ? `\n${description}` : '';
        return `${i + 1}. ${typeLabel} — ${p.neighbourhood}, ${p.city}${bedroomsPart} — ${formatXOF(p.price)}${descriptionPart}\nContact: ${p.agency_contact}`;
    });
    return lines.join('\n\n');
};

// Cards prefixed with the hardcoded intro — the fallback shape, used when the
// conversational composer is unavailable.
const formatListingsSummary = (listings, lang) =>
    `${BOT_STRINGS.results_intro[lang]}\n\n${formatListingsBody(listings, lang)}`;

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
        requestedDate: result.resolved_date,
        requestedTimeOfDay: result.time_of_day,
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

        const existingLeadState = await getLeadState(to);

        // Non-text message (image, sticker, voice note, ...) — we can't read
        // it, but it's still a real contact: log it and reply.
        //
        // A media message carries NO language signal, so we reply in the
        // lead's ALREADY-KNOWN language and pass null so getOrCreateLead
        // preserves it. Previously this defaulted to French and *wrote* that
        // default, which silently flipped an English conversation to French
        // for good the moment someone sent a photo.
        if (message.type !== 'text' || !text) {
            lang = existingLeadState?.language || DEFAULT_LANGUAGE;
            ({ id: leadId } = await getOrCreateLead(to, contactName, null));
            await saveConversationMessage(leadId, 'user', `[unsupported message type: ${message.type}]`);
            const mediaReply = await composeUnsupportedMedia({ lang, mediaType: message.type });
            await replyAndLog(to, leadId, mediaReply);
            return res.sendStatus(200);
        }

        // An explicit "reply in English please" beats everything below — it's
        // often a SHORT message and can arrive mid-booking, which are exactly
        // the two cases where we otherwise ignore the message's own language.
        const languageSwitchRequest = detectLanguageSwitchRequest(text);

        // Short replies ("ok", "oui", "1", "yes please") and mid-booking-flow
        // slot-fills aren't reliable language signals — detection on two words
        // flips languages at random. Trust the lead's established language in
        // those cases and only re-detect on a substantial message.
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const hasReliableLanguageSignal = wordCount > 3;
        if (languageSwitchRequest) {
            lang = languageSwitchRequest;
        } else if (existingLeadState && (existingLeadState.pendingAction || !hasReliableLanguageSignal)) {
            lang = existingLeadState.language;
        } else {
            lang = await detectLanguage(text);
        }

        const lead = await getOrCreateLead(to, contactName, lang);
        leadId = lead.id;
        await saveConversationMessage(leadId, 'user', text);

        let replyBody;
        let listingsShown = null; // set only when search results were just sent, for the media follow-up below
        let isGreetingReply = false; // a greeting is already a full welcome — never prefix it with another one
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

            if (languageSwitchRequest && filters.intent !== 'search') {
                // They only asked to change language — confirm in the NEW
                // language and invite a requirement, rather than treating
                // "in English please" as an off-topic message or dumping
                // listings at them. A switch bundled WITH a request
                // ("show me villas in english") falls through to the search
                // below, which now renders in the new language anyway.
                replyBody = await composeLanguageSwitch({ lang });
                isGreetingReply = true;
            } else if (filters.intent === 'off_topic') {
                replyBody = await composeOffTopic({ lang, userMessage: text });
            } else if (filters.intent === 'greeting') {
                // A pure greeting with no property information — welcome them
                // and invite a requirement. Already a full welcome on its own,
                // so it never gets the welcome_prefix below.
                replyBody = await composeGreeting({ lang, userMessage: text, isNewLead: lead.isNew });
                isGreetingReply = true;
            } else {
                // Real intent, even if vague ("anything cheap?"). An empty
                // filter set is NOT a reason to re-greet someone who just
                // asked a genuine question — fall through to the search,
                // which with no filters returns the cheapest listings.
                const searchFilters = {
                    city: filters.city,
                    neighbourhood: filters.neighbourhood,
                    type: filters.type,
                    price_max: filters.price_max,
                    bedrooms: filters.bedrooms,
                };
                const { listings, relaxed } = await searchPropertiesWithFallback(searchFilters);

                if (listings.length === 0) {
                    replyBody = await composeNoResults({ lang, userMessage: text });
                } else {
                    // Claude writes ONLY the intro line; the listing cards and
                    // the booking prompt stay template-rendered so no price or
                    // property detail can ever be model-invented.
                    const intro = await composeResultsIntro({
                        lang, userMessage: text, listings, relaxed, filters: searchFilters,
                    });
                    replyBody = `${intro}\n\n${formatListingsBody(listings, lang)}\n\n${BOT_STRINGS.booking_prompt[lang]}`;
                    // Remember which listings were shown (in the same numbered
                    // order) so a reply like "2" resolves to a specific property.
                    await setPendingViewingSelection(leadId, listings.map((p) => p.id));
                    listingsShown = listings;
                }
            }
        }

        // First-ever reply to a brand-new lead always opens with a welcome,
        // per CLAUDE.md's "first message from a new number → welcome
        // message" — but we still answer whatever they actually asked
        // rather than making them repeat themselves on a second turn.
        const replyText = (lead.isNew && !isGreetingReply)
            ? `${BOT_STRINGS.welcome_prefix[lang]}\n\n${replyBody}`
            : replyBody;

        await replyAndLog(to, leadId, replyText);

        // Photos follow the text card as separate messages, per CLAUDE.md's
        // WhatsApp message-type rules — text first, then image calls, never
        // combined. Only for listings that actually have photos uploaded.
        if (listingsShown) {
            await sendListingMedia(to, leadId, listingsShown, lang);
        }

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
    sendWhatsAppImage,
    sendWhatsAppVideo,
    sendWhatsAppLocation,
    handleMessage,
    extractSearchFilters,
    hasAnyFilter,
    formatListingsBody,
    formatListingsSummary,
    extractViewingSelection,
    extractAppointmentDateTime,
};
