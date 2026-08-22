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
    composeClosing,
    composeBookingPrompt,
    composeAskDatetime,
    composeBookingConfirmed,
    composeBookingDeclined,
    composeSelectionUnclear,
    composeMediaResent,
    composeListingAnswer,
    composeConfirmBooking,
    composeMidFlowAcknowledgement,
} = require('../utils/replyComposer');
const {
    getOrCreateLead,
    getLeadState,
    saveConversationMessage,
    getRecentConversation,
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

// How many past turns the bot "remembers". Enough to follow a multi-step
// requirement and a booking flow without sending a huge prompt every message.
const HISTORY_TURNS = 10;

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
    // 'closing' (thanks/bye) and 'booking_intent' ("yes I'd like to book") are
    // what stop the two worst stateless failures: thanking the bot used to be
    // classified as a greeting and got a full welcome message back, and a
    // plain "yes I want to book an appointment" used to fall through to
    // "I didn't quite catch that" because only a bare number was accepted.
    intent: z.enum(['search', 'off_topic', 'greeting', 'closing', 'booking_intent', 'unclear']),
    // Explicit request to be spoken to in another language, in ANY phrasing
    // ("now please english", "tu peux parler anglais ?"). Reading intent here
    // is what a fixed regex could never do reliably.
    language_request: z.enum(['fr', 'en']).nullable(),
    // The language the message itself is written in. Reported here so this
    // one call replaces the separate detectLanguage() round-trip.
    message_language: z.enum(['fr', 'en']),
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

You are given the RECENT CONVERSATION so far. Read the new message IN THAT CONTEXT — a short reply like "yes", "the second one" or "under 200000" only makes sense against what was just said.

Field guidance:
- intent:
  * "search" — any interest in finding/renting/buying/viewing property, even with a single detail ("just Lomé", "something cheap"). ALSO use this when the customer refines or adds to an earlier request ("under 200000", "actually make it 3 bedrooms") — see the filter-merging rule below.
  * "booking_intent" — they say they want to book/visit/see a property but have NOT identified which one ("yes I want to book an appointment", "je veux visiter"). Do NOT classify this as "unclear".
  * "closing" — thanks, goodbyes, acknowledgements that end an exchange ("thank you", "merci", "ok great", "bye", "that's all"). NEVER classify these as "greeting".
  * "greeting" — an OPENING greeting with no property information ("Bonjour", "Hi"). If the conversation already has messages, a bare "hi" is usually still a greeting, but "thanks" is "closing".
  * "off_topic" — clearly unrelated to real estate (weather, jokes, chit-chat).
  * "unclear" — only if genuinely none of the above fit.
- language_request: set to "en" or "fr" ONLY if the customer is asking to be SPOKEN TO in that language, in any phrasing ("now please english", "please english", "english now", "in english", "tu peux répondre en anglais ?", "français svp"). This is about the language of YOUR replies — not about the language they happen to be writing in, and not about a property feature (e.g. "near the English School" is NOT a language request). null otherwise.
- message_language: the language the NEW message is actually written in, "fr" or "en". For a very short or ambiguous message, infer from the conversation rather than guessing.
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

CRITICAL — CARRY FORWARD WHAT THEY ALREADY TOLD YOU:
The customer builds their requirement up across several messages. For every filter field, if the NEW message does not mention it but an EARLIER message in the conversation did, repeat that earlier value. Only use null when neither the new message nor the conversation ever mentioned it.
Example: "I want a villa in Lomé" then "under 300000" must produce city "Lomé", type "villa" AND price_max 300000 — not price alone.
The exception is an explicit change of mind ("actually, a apartment instead"), where the new value replaces the old one.

Never fabricate a value neither the message nor the conversation supports. When genuinely uncertain about a field, use null rather than guessing.`;
};

// Renders stored transcript rows as a readable dialogue for the prompt.
const formatHistoryForPrompt = (history = []) =>
    history
        .map((m) => `${m.sender === 'bot' ? 'You (EXCELIA)' : 'Customer'}: ${m.message}`)
        .join('\n');

// `history` is the last few turns (oldest first) from getRecentConversation().
// Passing it is what lets a bare "under 300000" or "yes please" be understood
// at all — without it every message was classified in isolation.
const extractSearchFilters = async (text, history = []) => {
    const fallback = {
        intent: 'unclear', language_request: null, message_language: null,
        city: null, neighbourhood: null, type: null, price_max: null, bedrooms: null,
    };
    if (!text || !text.trim()) return fallback;

    let knownLocations = [];
    try {
        knownLocations = await getKnownLocations();
    } catch (error) {
        console.error('Failed to fetch known locations for NLU prompt, proceeding without them:', error.message);
    }

    const conversationBlock = history.length
        ? `RECENT CONVERSATION (oldest first):\n${formatHistoryForPrompt(history)}\n\n---\n\n`
        : '';

    try {
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 400,
            temperature: 0,
            system: buildNluSystemPrompt(knownLocations),
            messages: [{ role: 'user', content: `${conversationBlock}NEW MESSAGE FROM CUSTOMER:\n${text}` }],
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
    // 'wants_to_book' covers an enthusiastic yes that doesn't name a listing
    // ("Yes I want to book an appointment!") — previously this landed in
    // 'unclear' and the lead got "I didn't quite catch that", which reads as
    // the bot ignoring a perfectly clear answer.
    // 'new_search' matters more than it looks: after results are shown the
    // lead is parked in the selection state, so a perfectly natural refinement
    // ("actually under 400000", "show me apartments instead") was being read
    // as an attempt to pick a listing. Detecting it lets the flow drop back
    // into search instead of trapping them in the booking prompt.
    decision: z.enum(['decline', 'select', 'express_interest', 'wants_to_book', 'new_search', 'request_media', 'question', 'greeting', 'closing', 'unclear']),
    selected_number: z.number().int().nullable(),
});

const extractViewingSelection = async (text, listingCount, history = []) => {
    const fallback = { decision: 'unclear', selected_number: null };
    if (!text || !text.trim()) return fallback;

    try {
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 200,
            temperature: 0,
            system: `The user was just shown a numbered list of ${listingCount} real estate properties (numbered 1 to ${listingCount}) and asked if they'd like to book a viewing. Classify their reply.
- decision:
  * "select" — they are clearly ASKING TO BOOK a specific one, or answering the "which one?" question with a bare choice ("1", "number 2", "the second one", "book the villa"). Set selected_number.
  * "express_interest" — they say they LIKE or prefer one, without actually asking to book it ("ok, 1 I liked", "the first one looks nice", "I prefer the villa", "j'aime bien le 2"). Liking is NOT the same as booking. Set selected_number.
  * "wants_to_book" — they clearly want to book but have NOT said which property ("yes", "yes I want to book an appointment", "oui je veux visiter"). An enthusiastic yes is NOT unclear.
  * "new_search" — they are changing or refining what they're looking for rather than picking from the list ("actually under 400000", "do you have apartments instead?", "what about Bè?", "something cheaper"). This is a NEW requirement, not a selection.
  * "request_media" — they are asking to SEE more of a specific listing rather than to book it ("can you share some photos of 1", "more pictures of the second one", "send me the video", "où se trouve le 2 ?"). Set selected_number to the listing they mean. Wanting to look at photos is NOT the same as choosing to book a viewing.
  * "question" — they are ASKING something about a listing rather than choosing ("what is the price of 2?", "how many bedrooms?", "where is it?"). Set selected_number if they name one.
  * "greeting" — a greeting or pleasantry ("hello", "hi", "bonjour", "ca va ?"). NOT a selection and NOT a decline.
  * "closing" — thanks / goodbye ("thanks", "merci", "ok great"). NOT a decline of the booking.
  * "decline" — ONLY an explicit refusal to book ("no", "not interested", "not now", "non merci"). A question, a greeting or a request for photos is NEVER a decline.
  * "unclear" — only if none of the above fit.
- selected_number: the 1-based number they selected, only when decision is "select" — must be between 1 and ${listingCount}. null otherwise.`,
            messages: [{ role: 'user', content: `${history.length ? `RECENT CONVERSATION (oldest first):\n${formatHistoryForPrompt(history)}\n\n---\n\n` : ''}CUSTOMER'S REPLY:\n${text}` }],
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
    // Only 'decline' may cancel a booking. Everything else keeps the flow
    // alive — previously a question like "what is the price again?" was
    // classified as decline and silently destroyed the booking.
    decision: z.enum(['datetime_given', 'decline', 'request_media', 'question', 'greeting', 'closing', 'unclear']),
    // Which listing the media/question is about, when they name one.
    selected_number: z.number().int().nullable(),
    iso_datetime: z.string().nullable(),
    resolved_date: z.string().nullable(),
    time_of_day: z.enum(['morning', 'afternoon', 'evening']).nullable(),
});

// `now` is injectable so the backfill script can re-resolve an OLD booking
// using the date it was actually made — "demain" means nothing without the
// reference point it was said relative to.
const extractAppointmentDateTime = async (text, referenceNow = null, history = []) => {
    const fallback = { decision: 'unclear', selected_number: null, iso_datetime: null, resolved_date: null, time_of_day: null };
    if (!text || !text.trim()) return fallback;

    try {
        const now = (referenceNow ? new Date(referenceNow) : new Date()).toISOString();
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 200,
            temperature: 0,
            system: `The current date/time is ${now} (UTC). The user was just asked for their preferred date and time for a property viewing in Togo, and is replying in French or English, possibly with a relative expression ("demain", "next Friday at 3pm", "vendredi prochain").
- decision — what the reply actually is:
  * "datetime_given" — they gave a date and/or time, even partially ("tomorrow", "friday afternoon", "asap").
  * "request_media" — they are asking to SEE the property ("can you share some photos?", "send me the video", "any pictures?"). This is NOT a decline.
  * "question" — they are asking something about the property ("what is the price again?", "where is it located?", "how many bedrooms?"). This is NOT a decline.
  * "greeting" — a greeting or pleasantry ("hello", "hi", "bonjour").
  * "closing" — thanks / goodbye ("thank you", "merci").
  * "decline" — ONLY an explicit refusal to continue booking ("no thanks", "forget it", "not anymore", "j'annule"). A question, a greeting, or a request for photos is NEVER a decline. If you are unsure, use "unclear", never "decline".
  * "unclear" — anything else you cannot place.
- selected_number: if they refer to a specific listing by number, that number; otherwise null.
- iso_datetime: resolve their reply to an absolute ISO 8601 datetime (assume Togo's timezone, UTC+0) ONLY if you can confidently determine both a date AND a specific clock time. If the time is vague ("matin", "morning", "dans la journée"), return null here — use resolved_date + time_of_day instead. Never invent a clock time.
- resolved_date: the calendar date they mean, as "YYYY-MM-DD" (Togo time, UTC+0), whenever the DATE is determinable — including relative expressions ("demain" -> the day after the current date above, "vendredi" -> the next upcoming Friday). Fill this in even when you also filled iso_datetime, and even when the time of day is unknown. null only if no date can be determined at all.
- time_of_day: "morning", "afternoon", or "evening" if they indicated a coarse part of the day ("matin", "après-midi", "le soir"). If they gave a specific clock time instead, still classify it (e.g. 15h -> "afternoon"). null if there is no time indication whatsoever.`,
            messages: [{ role: 'user', content: `${history.length ? `RECENT CONVERSATION (oldest first):
${formatHistoryForPrompt(history)}

---

` : ''}CUSTOMER'S REPLY:
${text}` }],
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
// Returns { text, mediaListings } rather than a bare string, because this is
// the one path where the lead can ask to SEE more of a listing — and the
// media send has to happen in handleMessage (which owns the WhatsApp
// connection). mediaListings is null unless media was requested.
// handleViewingDateTimeReply still returns a plain string; nothing in the
// date/time step can request media.
const handleViewingSelectionReply = async ({ leadId, text, lang, pendingListingIds, history = [] }) => {
    if (!pendingListingIds || pendingListingIds.length === 0) {
        // Defensive — shouldn't happen, but never get the lead stuck.
        await clearPendingAction(leadId);
        return { text: BOT_STRINGS.welcome_clarify[lang], mediaListings: null };
    }

    const selection = await extractViewingSelection(text, pendingListingIds.length, history);

    // They want to see more of a specific listing, not book it. Keep the
    // pending selection state — they haven't chosen anything yet.
    if (
        selection.decision === 'request_media' &&
        Number.isInteger(selection.selected_number) &&
        selection.selected_number >= 1 &&
        selection.selected_number <= pendingListingIds.length
    ) {
        const propertyId = pendingListingIds[selection.selected_number - 1];
        const property = await getPropertyById(propertyId);
        if (property) {
            const propertyLabel = `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`;
            const hasMedia = (property.photos && property.photos.length > 0) || property.video_url;
            const mediaText = await composeMediaResent({ lang, propertyLabel, hasMedia, history, stillNeeded: 'selection' });
            return { text: mediaText, mediaListings: hasMedia ? [property] : null };
        }
    }

    // Asked for photos but didn't say which listing — ask, don't guess.
    if (selection.decision === 'request_media') {
        return {
            text: await composeSelectionUnclear({ lang, userMessage: text, listingCount: pendingListingIds.length, history }),
            mediaListings: null,
        };
    }

    // A question about one of the listings — answer it from the DB and stay
    // in the selection flow rather than treating it as a failed choice.
    if (selection.decision === 'question') {
        const idx = Number.isInteger(selection.selected_number)
            && selection.selected_number >= 1
            && selection.selected_number <= pendingListingIds.length
            ? selection.selected_number - 1 : null;
        const property = idx === null ? null : await getPropertyById(pendingListingIds[idx]);
        if (property) {
            return {
                text: await composeListingAnswer({
                    lang, userMessage: text, propertyCard: formatListingsBody([property], lang), history, stillNeeded: 'selection',
                }),
                mediaListings: null,
            };
        }
    }

    // Greeting or thanks mid-selection — they have already met us; acknowledge
    // and pick the thread back up instead of sending a booking prompt.
    if (selection.decision === 'greeting' || selection.decision === 'closing') {
        return {
            text: await composeMidFlowAcknowledgement({
                lang, userMessage: text, history, stillNeeded: 'selection', listingCount: pendingListingIds.length,
            }),
            mediaListings: null,
        };
    }

    if (selection.decision === 'decline') {
        await clearPendingAction(leadId);
        return { text: await composeBookingDeclined({ lang, history }), mediaListings: null };
    }

    // They like one but haven't asked to book it. Confirm intent BEFORE asking
    // for a date — jumping straight to "what date suits you?" assumes a
    // decision the customer never actually made. Narrowing pendingListingIds
    // to the one they named means a following "yes" resolves to it.
    if (
        selection.decision === 'express_interest' &&
        Number.isInteger(selection.selected_number) &&
        selection.selected_number >= 1 &&
        selection.selected_number <= pendingListingIds.length
    ) {
        const propertyId = pendingListingIds[selection.selected_number - 1];
        const property = await getPropertyById(propertyId);
        if (property) {
            await setPendingViewingSelection(leadId, [propertyId]);
            const propertyLabel = `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`;
            return { text: await composeConfirmBooking({ lang, propertyLabel, history }), mediaListings: null };
        }
    }

    if (
        selection.decision === 'select' &&
        Number.isInteger(selection.selected_number) &&
        selection.selected_number >= 1 &&
        selection.selected_number <= pendingListingIds.length
    ) {
        const propertyId = pendingListingIds[selection.selected_number - 1];
        await setPendingViewingDatetime(leadId, propertyId);
        const property = await getPropertyById(propertyId);
        const propertyLabel = property
            ? `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`
            : '';
        return { text: await composeAskDatetime({ lang, propertyLabel, history }), mediaListings: null };
    }

    // They clearly want to book but didn't say which one — that's a normal
    // answer, not a misunderstanding. Keep the pending state and ask which.
    if (selection.decision === 'wants_to_book') {
        // Only one candidate left (they named it last turn and we asked to
        // confirm) — "yes" is unambiguous, so move on to the date.
        if (pendingListingIds.length === 1) {
            const propertyId = pendingListingIds[0];
            await setPendingViewingDatetime(leadId, propertyId);
            const property = await getPropertyById(propertyId);
            const propertyLabel = property
                ? `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`
                : '';
            return { text: await composeAskDatetime({ lang, propertyLabel, history }), mediaListings: null };
        }
        return { text: await composeBookingPrompt({ lang, listingCount: pendingListingIds.length, history }), mediaListings: null };
    }

    // Not a selection at all — they're refining what they want. Drop the
    // booking state and signal the caller to run a fresh search instead of
    // trapping them in "which number?".
    if (selection.decision === 'new_search') {
        await clearPendingAction(leadId);
        return null;
    }

    // Genuinely couldn't tell which listing they meant.
    return {
        text: await composeSelectionUnclear({ lang, userMessage: text, listingCount: pendingListingIds.length, history }),
        mediaListings: null,
    };
};

// ── Booking flow, step 2: their preferred date/time ──
// Last-resort guard so a message like "Hello" can never be stored as the
// requested viewing time. Only used when the model claimed datetime_given
// but resolved no date at all.
const looksLikeDateText = (text) => /\d|today|tomorrow|tonight|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|aujourd|demain|matin|midi|soir|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|semaine/i.test(text || '');

const handleViewingDateTimeReply = async ({ leadId, propertyId, text, lang, history }) => {
    const result = await extractAppointmentDateTime(text, null, history);
    const property = await getPropertyById(propertyId);
    const propertyLabel = property
        ? `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`
        : '';

    // ONLY an explicit refusal clears the booking. Everything else keeps the
    // flow alive — a question or a photo request used to be classified as a
    // decline here, which silently cancelled the lead's booking.
    if (result.decision === 'decline') {
        await clearPendingAction(leadId);
        return { text: await composeBookingDeclined({ lang, history }), mediaListings: null };
    }

    // They want to see the property before committing to a time.
    if (result.decision === 'request_media' && property) {
        const hasMedia = (property.photos && property.photos.length > 0) || property.video_url;
        return {
            text: await composeMediaResent({ lang, propertyLabel, hasMedia, history, stillNeeded: 'date' }),
            mediaListings: hasMedia ? [property] : null,
        };
    }

    // A question about the property. Answered from the DB row, then we pick
    // the conversation back up where it was.
    if (result.decision === 'question' && property) {
        return {
            text: await composeListingAnswer({
                lang, userMessage: text, propertyCard: formatListingsBody([property], lang), history, stillNeeded: 'date',
            }),
            mediaListings: null,
        };
    }

    // Greeting / thanks / anything unparseable mid-flow: acknowledge and
    // re-ask for the date, WITHOUT restarting or cancelling.
    if (result.decision !== 'datetime_given' || (!result.resolved_date && !result.iso_datetime && !looksLikeDateText(text))) {
        return {
            text: await composeAskDatetime({ lang, propertyLabel, history, isReAsk: true }),
            mediaListings: null,
        };
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

    // Wrapper is composed; the factual recap underneath stays deterministic.
    const confirmation = await composeBookingConfirmed({ lang, history });
    return { text: `${confirmation}

${propertyLabel}
${text}`, mediaListings: null };
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

        // The bot's short-term memory. Loaded BEFORE the lead row is touched
        // so the current message isn't in it yet — history is strictly "what
        // was said before now".
        const history = existingLeadState
            ? await getRecentConversation(existingLeadState.id, HISTORY_TURNS)
            : [];

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

        // Free regex fast path for the unambiguous phrasings ("english",
        // "en français"). It's deliberately NOT the only mechanism — it misses
        // natural wordings like "now please english", which is why the NLU
        // below also reports language_request.
        const regexSwitchRequest = detectLanguageSwitchRequest(text);

        // Mid-booking replies are slot-fills ("1", "tomorrow 11am") and go to
        // the dedicated booking NLUs, so the general understanding call is
        // skipped there — no wasted round-trip.
        const inPendingFlow = Boolean(existingLeadState?.pendingAction);
        let understanding = inPendingFlow ? null : await extractSearchFilters(text, history);

        // Language precedence: an explicit request (however phrased) wins;
        // then, for short/mid-flow messages, the established language (two
        // words are not a reliable signal — that unreliability is what caused
        // the original FR/EN flip-flopping); then the message's own language.
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const languageSwitchRequest = regexSwitchRequest || understanding?.language_request || null;
        if (languageSwitchRequest) {
            lang = languageSwitchRequest;
        } else if (existingLeadState && (inPendingFlow || wordCount <= 3)) {
            lang = existingLeadState.language;
        } else {
            lang = understanding?.message_language || existingLeadState?.language || await detectLanguage(text);
        }

        const lead = await getOrCreateLead(to, contactName, lang);
        leadId = lead.id;
        await saveConversationMessage(leadId, 'user', text);

        let replyBody;
        let listingsShown = null; // set only when search results were just sent, for the media follow-up below
        let isGreetingReply = false; // a greeting is already a full welcome — never prefix it with another one
        if (lead.pendingAction === 'awaiting_viewing_selection') {
            const selectionResult = await handleViewingSelectionReply({
                leadId,
                text,
                lang,
                pendingListingIds: lead.pendingListingIds,
                history,
            });
            // null = "this wasn't a selection, they're searching again".
            // Load the understanding we skipped and fall through to search.
            if (selectionResult === null) {
                understanding = await extractSearchFilters(text, history);
            } else {
                replyBody = selectionResult.text;
                // They asked to see more of a listing — resend its media after
                // the text reply, same ordering as a fresh search result.
                if (selectionResult.mediaListings) listingsShown = selectionResult.mediaListings;
            }
        }

        if (replyBody !== undefined && replyBody !== null) {
            // already handled by the booking flow above
        } else if (lead.pendingAction === 'awaiting_viewing_datetime') {
            const dateResult = await handleViewingDateTimeReply({
                leadId,
                propertyId: lead.pendingPropertyId,
                text,
                lang,
                history,
            });
            replyBody = dateResult.text;
            // They asked to see the property before naming a time.
            if (dateResult.mediaListings) listingsShown = dateResult.mediaListings;
        } else {
            const filters = understanding;

            if (languageSwitchRequest && filters.intent !== 'search') {
                // They only asked to change language — confirm in the NEW
                // language, rather than treating "now please english" as
                // off-topic or dumping listings at them. A switch bundled WITH
                // a request ("show me villas in english") falls through to the
                // search below, which renders in the new language anyway.
                replyBody = await composeLanguageSwitch({ lang, history });
                isGreetingReply = true;
            } else if (filters.intent === 'closing') {
                // "Thank you" / "merci" / "ok bye". Must NOT be answered with a
                // welcome — that was the most robotic-looking failure in
                // testing (thanking the bot after booking got a full greeting).
                const justBooked = history.some((m) => m.sender === 'bot' && m.message.includes(BOT_STRINGS.booking_confirmed[lang]))
                    || Boolean(existingLeadState && !existingLeadState.pendingAction && history.length > 2);
                replyBody = await composeClosing({ lang, userMessage: text, history, justBooked });
                isGreetingReply = true;
            } else if (filters.intent === 'booking_intent') {
                // They want to book but no listings are pending — they haven't
                // been shown anything yet, so find out what they want first.
                replyBody = await composeGreeting({ lang, userMessage: text, isNewLead: lead.isNew, history });
                isGreetingReply = true;
            } else if (filters.intent === 'off_topic') {
                replyBody = await composeOffTopic({ lang, userMessage: text, history });
            } else if (filters.intent === 'greeting') {
                // A pure greeting with no property information — welcome them
                // and invite a requirement. Already a full welcome on its own,
                // so it never gets the welcome_prefix below.
                replyBody = await composeGreeting({ lang, userMessage: text, isNewLead: lead.isNew, history });
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
                    replyBody = await composeNoResults({ lang, userMessage: text, history });
                } else {
                    // Claude writes ONLY the intro line; the listing cards and
                    // the booking prompt stay template-rendered so no price or
                    // property detail can ever be model-invented.
                    const intro = await composeResultsIntro({
                        lang, userMessage: text, listings, relaxed, filters: searchFilters, history,
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
    handleViewingSelectionReply,
    handleViewingDateTimeReply,
    extractSearchFilters,
    hasAnyFilter,
    formatListingsBody,
    formatListingsSummary,
    extractViewingSelection,
    extractAppointmentDateTime,
};
