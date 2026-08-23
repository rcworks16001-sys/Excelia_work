const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
// zodOutputFormat expects v4-shaped schemas — see note in utils/language.js.
const { z } = require('zod/v4');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const pool = require('../db/index');
const { rankPropertiesForLead, getPropertyById, getKnownLocations } = require('./propertyController');
const {
    getProfile, mergeProfile, recordShownListings, recordInterest, recordRejectionReason,
    profileToSearchFilters, flagForHuman, refreshLeadSignals,
} = require('./leadProfileController');
const { recordEvent, countTrailingEvents, EVENT_TYPES } = require('./leadEventController');
const { createNotification } = require('./notificationController');
const { ACTIONS, nextBestAction } = require('../utils/nextBestAction');
const { findKnowledge, knowledgeBlock } = require('../utils/knowledge');
const {
    composeResultsIntro,
    composeNoResults,
    composeGreeting,
    composeOffTopic,
    composeUnsupportedMedia,
    composeHandoff,
    composeAskRejectionReason,
    composeComparison,
    composeKnowledgeAnswer,
    composeObjection,
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
    composeAskNeighbourhood,
    composeAskBudget,
} = require('../utils/replyComposer');
const {
    getOrCreateLead,
    getLeadState,
    saveConversationMessage,
    getRecentConversation,
    setPendingViewingSelection,
    setPendingViewingDatetime,
    clearPendingAction,
    updateLeadNameIfMissing,
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
// How many listing cards a search reply shows. Deliberately equal to
// MAX_LISTINGS_WITH_PHOTOS: they were 10 and 3, so a lead could receive ten
// text cards and photos for only the first three, with nothing explaining why.
// After this many consecutive failures to understand a reply, stop rephrasing
// and get a person involved (doc §22, "repeated misunderstanding").
const REPEATED_MISUNDERSTANDING_LIMIT = 3;
const MAX_LISTINGS_SHOWN = 3;
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
    // 'wants_human' covers everything the bot must not attempt: an explicit
    // request for a person, price negotiation, complaints, and legal/financial
    // questions. They are ONE intent because they all produce one action —
    // hand over. The specific reason rides along in handoff_reason instead of
    // splitting this into four intents that branch identically.
    // 'general_question' is about how property WORKS here (cour commune, titre
    // foncier, deposits, viewings) as opposed to a specific listing. These used
    // to fall into off_topic and get deflected — a lead asking a perfectly
    // sensible question was told the bot only does property search.
    intent: z.enum(['search', 'general_question', 'off_topic', 'greeting', 'closing', 'booking_intent', 'wants_human', 'unclear']),
    // Only meaningful when intent is 'wants_human'.
    handoff_reason: z.enum(['asked_for_agent', 'negotiation', 'complaint', 'legal_or_financial']).nullable(),
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
    // Renting vs buying. Null unless they actually signalled it — most
    // enquiries here are rentals and guessing 'sale' from an ambiguous
    // message would filter the catalogue down to two land plots.
    transaction: z.enum(['rent', 'sale']).nullable(),

    // ── Profile fields: remembered across turns, not just this search ──
    // The most they'd stretch to, when they say so ("I could go to 90"). Kept
    // apart from price_max because it is a different promise: price_max is an
    // estimate we may nudge, this is a wall they named themselves.
    budget_stretch_max: z.number().int().nullable(),
    // "2 or 3 bedrooms" is a range that a single bedrooms field cannot hold.
    bedrooms_min: z.number().int().nullable(),
    bedrooms_max: z.number().int().nullable(),
    purpose: z.enum(['self_use', 'investment', 'rental_income']).nullable(),
    timeline: z.enum(['immediate', 'within_1_month', 'within_3_months', 'later', 'exploring']).nullable(),

    // ── Retraction ──
    // The third state. In JSON, "they didn't mention their budget" and "they
    // told me to forget their budget" are both null, so the difference has to
    // be carried out of band or the profile becomes a ratchet that can only
    // ever accumulate constraints. See mergeProfile in leadProfileController.
    cleared_fields: z.array(z.enum([
        'transaction', 'property_type', 'city', 'neighbourhood',
        'bedrooms_min', 'bedrooms_max', 'budget_max', 'budget_stretch_max',
        'purpose', 'timeline',
    ])),
    // Passive capture: if a lead volunteers their name unprompted ("Hi, I'm
    // Kofi, looking for..."), take it — separate from the explicit ask in the
    // booking flow (composeAskDatetime), which is the primary way a name gets
    // collected. null unless they actually stated it themselves.
    stated_name: z.string().nullable(),

    // ── Qualifying-question gate (nextBestAction.js) ──
    // An EXPLICIT "I don't care" — distinct from simply not having answered
    // yet. true ONLY when they actually say so; null otherwise (never guess
    // this from silence — the gate's whole point is to actually ask).
    neighbourhood_no_preference: z.boolean().nullable(),
    budget_no_preference: z.boolean().nullable(),
});

// Builds the NLU system prompt, optionally injecting the list of known
// cities/neighbourhoods so Claude can tell a bare neighbourhood name
// ("Avédji") apart from a city name instead of guessing — without this list,
// a message that only names a neighbourhood (no city) got misclassified as
// { city: "Avedji", neighbourhood: null }, and the search then found nothing
// even though a matching listing existed. knownLocations is
// [{ city, neighbourhood }, ...] from propertyController.getKnownLocations();
// pass [] to fall back to the plain prompt (e.g. if that query fails).
const buildNluSystemPrompt = (knownLocations = [], profile = null) => {
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

    // What we already know about this lead, stated as fact so the model reports
    // only what CHANGED. This replaced an instruction telling it to re-read the
    // transcript and repeat any earlier values it found. Both together would be
    // two competing memories: the transcript one sees a 10-row window, the
    // profile sees everything, and once they disagree the re-derived value
    // silently overwrites the older, better one. Exactly one source of truth.
    const known = profile
        ? Object.entries({
            transaction: profile.transaction,
            property_type: profile.property_type,
            city: profile.city,
            neighbourhood: profile.neighbourhood,
            bedrooms_min: profile.bedrooms_min,
            bedrooms_max: profile.bedrooms_max,
            price_max: profile.budget_max,
            budget_stretch_max: profile.budget_stretch_max,
            purpose: profile.purpose,
            timeline: profile.timeline,
        }).filter(([, v]) => v !== null && v !== undefined)
        : [];
    // Booleans default to false in the DB, so they can't go through the
    // generic null-check above (false would wrongly pass it) — only surface
    // them when actually true, i.e. when the customer already said so.
    if (profile?.neighbourhood_no_preference) known.push(['neighbourhood_no_preference', 'true (they said any area is fine)']);
    if (profile?.budget_no_preference) known.push(['budget_no_preference', 'true (they said any budget is fine)']);

    const profileBlock = known.length
        ? `WHAT YOU ALREADY KNOW ABOUT THIS CUSTOMER (established over previous messages — this is already saved, you do NOT need to repeat it):
${known.map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Report ONLY what this new message ADDS or CHANGES. If a field above is unchanged, set it to null — null means "no change", not "forget it". To actually drop one, list it in cleared_fields.`
        : `Nothing is known about this customer yet — this is the start of their requirement.`;

    return `You are the natural-language-understanding engine for EXCELIA, a WhatsApp real estate chatbot for Togo. Read the incoming WhatsApp message (French or English — understand both) and classify it.

You are given the RECENT CONVERSATION so far. Read the new message IN THAT CONTEXT — a short reply like "yes", "the second one" or "under 200000" only makes sense against what was just said.

Field guidance:
- intent:
  * "search" — any interest in finding/renting/buying/viewing property, even with a single detail ("just Lomé", "something cheap"). ALSO use this when the customer refines or adds to an earlier request ("under 200000", "actually make it 3 bedrooms") — see the filter-merging rule below.
  * "booking_intent" — they say they want to book/visit/see a property but have NOT identified which one ("yes I want to book an appointment", "je veux visiter"). Do NOT classify this as "unclear".
  * "closing" — thanks, goodbyes, acknowledgements that end an exchange ("thank you", "merci", "ok great", "bye", "that's all"). NEVER classify these as "greeting".
  * "greeting" — an OPENING greeting with no property information ("Bonjour", "Hi"). If the conversation already has messages, a bare "hi" is usually still a greeting, but "thanks" is "closing".
  * "general_question" — a question about how property works in Togo rather than about a specific listing: what a "cour commune" or "chambre salon" is, what a "titre foncier" is, deposits and advances, how a viewing works, what furnished means, what the neighbourhoods are like. Real estate, but not a search — do NOT classify these as off_topic.
  * "off_topic" — clearly unrelated to real estate (weather, jokes, chit-chat).
  * "wants_human" — they need a person, not a bot. Use for: asking to speak to someone ("can I talk to an agent?", "je veux parler à quelqu'un"); trying to negotiate price or terms ("can you lower the price?", "c'est négociable ?"); complaining about the agency or a property; or asking a legal/financial/contractual question (titre foncier disputes, contracts, loans, taxes). Prefer this over guessing whenever answering wrongly could mislead them about money or legal standing.
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
- transaction: "rent" or "sale", ONLY when the customer actually signals which they want. "louer", "à louer", "rent", "renting", "monthly" -> "rent". "acheter", "à vendre", "buy", "purchase", "own" -> "sale". Land ("terrain", "parcelle") is normally bought, so a bare request for a terrain implies "sale". Otherwise null — most enquiries are rentals and an unfounded "sale" guess would wrongly rule out almost the whole catalogue.
- budget_stretch_max: set ONLY when they signal flexibility ABOVE their stated budget — "I could stretch to 90", "maximum 90 but ideally 80", "je peux aller jusqu'à 90". The stated/preferred figure goes in price_max, the upper limit here. If they name a single firm number, leave this null.
- bedrooms_min / bedrooms_max: use when they give a RANGE ("2 or 3 bedrooms", "at least 3", "entre 2 et 4"). For a single number, set both to that number. null if bedrooms were not mentioned.
- purpose: "self_use" (to live in), "investment" (to resell/appreciate), "rental_income" (to rent out). null unless they say so.
- timeline: "immediate", "within_1_month", "within_3_months", "later", or "exploring" (just browsing, no timeframe). null unless they indicate one.
- handoff_reason: only when intent is "wants_human" — "asked_for_agent", "negotiation", "complaint", or "legal_or_financial". null otherwise.
- cleared_fields: list any field the customer has EXPLICITLY told you to drop or stop applying — "forget the budget", "actually never mind the area". This is ONLY for a deliberate retraction. Simply not mentioning a field in this message is NOT a retraction — leave it out of this list and set that field to null. Almost always an empty array.
- stated_name: their own name, ONLY if they give it themselves ("I'm Kofi", "my name is Ama", "c'est Koffi"). Never guess it from a WhatsApp display name or anywhere else. null in the overwhelming majority of messages — most people never mention their name unprompted.
- neighbourhood_no_preference: true ONLY if they explicitly say they have no preference for area/neighbourhood — "anywhere is fine", "any area works", "no preference", "peu importe le quartier", "n'importe où". This is a real answer to "which neighbourhood?", not a retraction — if they say this AFTER having named a neighbourhood, also add "neighbourhood" to cleared_fields (they've moved from a specific area to no preference). null otherwise; never infer this from silence.
- budget_no_preference: true ONLY if they explicitly say they have no budget limit — "any budget", "no limit", "budget is flexible", "peu importe le prix", "pas de limite", "budget is open". Same rule: if said after a figure was already given, also clear "budget_max". null otherwise.

${profileBlock}

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
// `profile` is the lead's stored requirement (leadProfileController) — passed
// so the model reports only what CHANGED rather than re-deriving everything
// from a 10-row transcript window each turn.
const extractSearchFilters = async (text, history = [], profile = null) => {
    const fallback = {
        intent: 'unclear', language_request: null, message_language: null,
        city: null, neighbourhood: null, type: null, price_max: null, bedrooms: null, transaction: null,
        budget_stretch_max: null, bedrooms_min: null, bedrooms_max: null,
        purpose: null, timeline: null, handoff_reason: null, cleared_fields: [], stated_name: null,
        neighbourhood_no_preference: null, budget_no_preference: null,
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
            // Raised from 400 with the profile fields. A truncated response
            // fails to parse and falls back to intent 'unclear' with every
            // filter null — i.e. the lead's entire message is silently thrown
            // away. Cheap insurance against a failure mode that looks like the
            // bot simply not understanding.
            max_tokens: 800,
            temperature: 0,
            system: buildNluSystemPrompt(knownLocations, profile),
            messages: [{ role: 'user', content: `${conversationBlock}NEW MESSAGE FROM CUSTOMER:\n${text}` }],
            output_config: { format: zodOutputFormat(NLUSchema) },
        });
        const parsed = response.parsed_output;
        if (!parsed) {
            // Distinct from the catch below: the call SUCCEEDED but produced
            // nothing usable (almost always truncation). Logged separately so
            // the two are not confused when diagnosing.
            console.error('NLU returned no parsed output (possible truncation) for message:', text.slice(0, 80));
            return fallback;
        }

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
    // 'wants_human' is an ESCAPE, not an exit: negotiating a price or asking
    // for an agent mid-booking must reach a person WITHOUT destroying the
    // viewing they were arranging. It escalates and keeps the flow alive.
    // 'reject_property' is about ONE listing they didn't like — distinct from
    // 'decline', which ends the whole booking. "I don't like the first one" is
    // a refinement signal, not a goodbye; treating it as one used to end the
    // conversation on someone who was still shopping.
    // 'objection' is pushback on the WHOLE set with no listing named and no new
    // criteria given ("these are all too expensive", "I'll think about it").
    // Distinct from reject_property (one listing) and new_search (they stated
    // something new) because the right answer differs: a price objection
    // deserves a concrete cheaper option, not another question.
    decision: z.enum(['decline', 'select', 'express_interest', 'reject_property', 'objection', 'compare', 'wants_to_book', 'new_search', 'request_media', 'question', 'greeting', 'closing', 'wants_human', 'unclear']),
    objection_type: z.enum(['price', 'location', 'size', 'thinking_about_it']).nullable(),
    selected_number: z.number().int().nullable(),
    // For 'compare': which listings they want set side by side. Two or three;
    // beyond that a WhatsApp message stops being readable.
    compare_numbers: z.array(z.number().int()).nullable(),
    handoff_reason: z.enum(['asked_for_agent', 'negotiation', 'complaint', 'legal_or_financial']).nullable(),
    // Why they turned it down, when they say. null means they just said "no" —
    // which is the cue to ask.
    rejection_reason: z.enum(['price', 'location', 'size', 'type', 'other']).nullable(),
});

const extractViewingSelection = async (text, listingCount, history = []) => {
    const fallback = { decision: 'unclear', selected_number: null, compare_numbers: null, handoff_reason: null, rejection_reason: null, objection_type: null };
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
  * "request_media" — they are asking for PHOTOS or VIDEO of a specific listing ("can you share some photos of 1", "more pictures of the second one", "send me the video", "any images?"). This is specifically about visual media — never use it for a request for information/description.
  * "question" — they are ASKING for information about a listing rather than choosing, INCLUDING a general request to know more about it. This covers both a narrow fact ("what is the price of 2?", "how many bedrooms?") AND a general request for detail ("tell me more about the 2nd one", "more details on number 1", "what's the story with number 2", "en dire plus sur le premier", "où se trouve le 2 ?" [asking a location FACT, not to be sent a media file]). The word "more" here means MORE INFORMATION, not more photos — only classify as "request_media" if they explicitly name a visual thing (photo, picture, image, video). Set selected_number if they name one.
  * "objection" — they push back on ALL of them without naming one and without giving new criteria ("these are all too expensive", "it's out of my price range", "too far from everything", "I'll think about it", "je vais réfléchir"). Set objection_type: "price", "location", "size", or "thinking_about_it". If they name a specific listing use "reject_property"; if they state a new requirement use "new_search".
  * "compare" — they want two or three listings set side by side ("compare 1 and 3", "what's the difference between the first two?", "quelle est la différence entre 1 et 2 ?"). Set compare_numbers to the listing numbers they named. If they say "compare them" without naming any, set compare_numbers to all of them.
  * "reject_property" — they DISLIKE one of the listings shown, without ending the conversation ("I don't like the first one", "not the second one", "le 1 ne me plaît pas", "the villa is too expensive"). Set selected_number. Set rejection_reason if they say WHY ("too expensive" -> "price", "too far"/"wrong area" -> "location", "too small"/"not enough rooms" -> "size", "I wanted an apartment" -> "type"); leave rejection_reason null if they just said no. This is NOT a decline — they are still looking.
  * "wants_human" — they need a person: asking to speak to an agent, trying to NEGOTIATE the price or terms ("can you lower the price?", "c'est négociable ?", "any discount?"), complaining, or asking a legal/financial/contractual question. Set handoff_reason. Note this is different from "question" — asking what the price IS is a question; asking for it to be CHANGED is a negotiation only a person can handle.
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
    // 'wants_human' escalates WITHOUT cancelling the booking — see the note on
    // ViewingSelectionSchema. Only 'decline' ends a booking, still.
    decision: z.enum(['datetime_given', 'decline', 'request_media', 'question', 'greeting', 'closing', 'wants_human', 'unclear']),
    handoff_reason: z.enum(['asked_for_agent', 'negotiation', 'complaint', 'legal_or_financial']).nullable(),
    // Which listing the media/question is about, when they name one.
    selected_number: z.number().int().nullable(),
    iso_datetime: z.string().nullable(),
    resolved_date: z.string().nullable(),
    time_of_day: z.enum(['morning', 'afternoon', 'evening']).nullable(),
    // Set when composeAskDatetime asked for a name alongside the date (see
    // needsName) and they gave one, e.g. "Kofi, tomorrow 11am" or a bare
    // "Ama". Also catches it if they volunteer it without being asked.
    stated_name: z.string().nullable(),
});

// `now` is injectable so the backfill script can re-resolve an OLD booking
// using the date it was actually made — "demain" means nothing without the
// reference point it was said relative to.
const extractAppointmentDateTime = async (text, referenceNow = null, history = []) => {
    const fallback = { decision: 'unclear', selected_number: null, iso_datetime: null, resolved_date: null, time_of_day: null, handoff_reason: null, stated_name: null };
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
  * "request_media" — they are asking for PHOTOS or VIDEO of the property ("can you share some photos?", "send me the video", "any pictures?"). Only for an explicit request for a visual file. This is NOT a decline.
  * "question" — they are asking for information about the property, including a general request to know more ("what is the price again?", "where is it located?", "how many bedrooms?", "tell me more about it", "more details please"). The word "more" here means MORE INFORMATION unless they explicitly name a photo/picture/video. This is NOT a decline.
  * "greeting" — a greeting or pleasantry ("hello", "hi", "bonjour").
  * "closing" — thanks / goodbye ("thank you", "merci").
  * "wants_human" — they need a person: asking for an agent, trying to NEGOTIATE price or terms ("can you lower the price?", "c'est négociable ?"), complaining, or asking a legal/financial question. Set handoff_reason. This is NOT a decline — they may still want the viewing.
  * "decline" — ONLY an explicit refusal to continue booking ("no thanks", "forget it", "not anymore", "j'annule"). A question, a greeting, or a request for photos is NEVER a decline. If you are unsure, use "unclear", never "decline".
  * "unclear" — anything else you cannot place.
- selected_number: if they refer to a specific listing by number, that number; otherwise null.
- iso_datetime: resolve their reply to an absolute ISO 8601 datetime (assume Togo's timezone, UTC+0) ONLY if you can confidently determine both a date AND a specific clock time. If the time is vague ("matin", "morning", "dans la journée"), return null here — use resolved_date + time_of_day instead. Never invent a clock time.
- resolved_date: the calendar date they mean, as "YYYY-MM-DD" (Togo time, UTC+0), whenever the DATE is determinable — including relative expressions ("demain" -> the day after the current date above, "vendredi" -> the next upcoming Friday). Fill this in even when you also filled iso_datetime, and even when the time of day is unknown. null only if no date can be determined at all.
- time_of_day: "morning", "afternoon", or "evening" if they indicated a coarse part of the day ("matin", "après-midi", "le soir"). If they gave a specific clock time instead, still classify it (e.g. 15h -> "afternoon"). null if there is no time indication whatsoever.
- stated_name: their own name, if this reply gives one — either because you just asked for it ("Kofi, tomorrow 11am", or a bare "Ama" alongside a date) or because they volunteer it. null if no name is present in this reply.`,
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

        // "Why this one" — rendered from the match scores, never written by the
        // model. Every line traces to a criterion the lead actually stated
        // (propertyMatcher emits nothing for criteria they didn't), so this
        // can't drift into implying a match that was never asked for.
        //
        // ✗ lines matter as much as ✓ ones: naming the trade-off out loud is
        // what lets someone judge a near-miss instead of being quietly handed a
        // substitute and left to spot the difference themselves.
        const reasonPart = (p.matchReasons && p.matchReasons.length)
            ? `\n${p.matchReasons.map((r) => `${r.matched ? '✓' : '✗'} ${r.label}`).join('  ')}`
            : '';

        return `${i + 1}. ${typeLabel} — ${p.neighbourhood}, ${p.city}${bedroomsPart} — ${formatXOF(p.price)}${reasonPart}${descriptionPart}\nContact: ${p.agency_contact}`;
    });
    return lines.join('\n\n');
};

// ── listingAnswerFacts(property, lang) ──
// The three deterministic inputs composeListingAnswer is allowed to work
// from: a label and price it may state VERBATIM, and the DB's own
// description text (never model-generated). Shared by both "question"
// call sites (selection step and datetime step) so the language-selection
// logic for description_en/description stays in exactly one place.
const listingAnswerFacts = (property, lang) => ({
    propertyLabel: `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`,
    priceLabel: formatXOF(property.price),
    description: lang === 'en' ? (property.description_en || property.description) : property.description,
});

// ── formatComparison(properties, lang) ──
// Two or three listings set attribute by attribute, so the differences are
// readable at a glance instead of buried in three separate cards.
//
// Every figure here comes straight from the DB row — same deterministic-facts
// boundary as the listing cards. The model contributes only the one-line
// "which would suit you" sentence appended afterwards, and only ever in terms
// of priorities the lead actually stated.
//
// A real table doesn't survive WhatsApp (no monospace, narrow screens), so
// this groups by attribute rather than drawing columns.
const formatComparison = (properties, lang) => {
    const L = lang === 'fr'
        ? { price: 'Prix', type: 'Type', area: 'Quartier', beds: 'Chambres', deal: 'Transaction', rent: 'À louer', sale: 'À vendre', none: '—' }
        : { price: 'Price', type: 'Type', area: 'Area', beds: 'Bedrooms', deal: 'Transaction', rent: 'For rent', sale: 'For sale', none: '—' };

    const header = properties
        .map((p, i) => `${i + 1}. ${PROPERTY_TYPE_LABELS[p.type]?.[lang] ?? p.type} — ${p.neighbourhood}`)
        .join('\n');

    const row = (label, valueOf) =>
        `${label}: ${properties.map((p, i) => `(${i + 1}) ${valueOf(p)}`).join('   ')}`;

    const lines = [
        row(L.price, (p) => formatXOF(p.price)),
        row(L.area, (p) => `${p.neighbourhood}, ${p.city}`),
        row(L.beds, (p) => (p.bedrooms != null ? String(p.bedrooms) : L.none)),
        row(L.deal, (p) => (p.transaction === 'sale' ? L.sale : L.rent)),
    ];

    return `${header}\n\n${lines.join('\n')}`;
};

// ── comparisonFactSheet(properties, lang) ──
// The same listings as formatComparison, PLUS each one's description, given to
// the composer so its steer can talk about what actually distinguishes them
// ("a pool", "near the sea") instead of only restating the numbers.
//
// This exists because without it the model reached into the conversation
// history for those details — they were real (the descriptions had already
// been sent as part of the listing cards) but it was re-deriving which feature
// belonged to which property, which is precisely how a confident
// misattribution happens. Supplying them explicitly and labelled makes the
// prompt's "nothing beyond what is listed here" rule actually enforceable.
//
// NOT sent to the customer — the visible table stays compact.
const comparisonFactSheet = (properties, lang) => properties
    .map((p, i) => {
        const description = lang === 'en' ? (p.description_en || p.description) : p.description;
        return `(${i + 1}) ${PROPERTY_TYPE_LABELS[p.type]?.[lang] ?? p.type}, ${p.neighbourhood}, ${formatXOF(p.price)}`
            + `${p.bedrooms != null ? `, ${p.bedrooms} bedroom(s)` : ''}`
            + `${description ? ` — ${description}` : ''}`;
    })
    .join('\n');

// Cards prefixed with the hardcoded intro — the fallback shape, used when the
// conversational composer is unavailable.
const formatListingsSummary = (listings, lang) =>
    `${BOT_STRINGS.results_intro[lang]}\n\n${formatListingsBody(listings, lang)}`;

// ── performSearchAndRespond(leadId, profile, { lang, history, userMessage, lockType }) ──
// The one place a property search is actually executed and turned into a
// reply. Extracted so the price-driven re-search after a rejection/objection
// (below) can call it directly against the profile it JUST updated, instead
// of returning null and forcing a second, redundant NLU pass over the
// rejection message itself ("too expensive" alone carries no type/city/
// bedrooms information to re-extract, and re-classifying it risked
// misreading it as something else entirely).
//
// lockType is the actual bug fix: without it, a soft-scored ranking lets a
// tightened budget ceiling surface a cheaper WRONG-TYPE listing ahead of an
// over-budget CORRECT-TYPE one (WEIGHTS.budget + WEIGHTS.location together
// outweigh WEIGHTS.type in propertyMatcher.js) — a lead who rejected a villa
// as "too expensive" was shown single rooms. See rankProperties for the
// mechanics; this is the only caller that passes lockType: true.
const performSearchAndRespond = async (leadId, profile, { lang, history = [], userMessage = '', lockType = false } = {}) => {
    // Filters come from the PROFILE, not the triggering message — a
    // requirement built up over several turns (or just updated by a
    // rejection handler) is searched in full.
    const searchFilters = profileToSearchFilters(profile);
    // Ranked, not filtered: near-misses are shown in position with an honest
    // ✗ rather than silently dropped or silently substituted. Capped low —
    // the doc's "show 3-5, not 20" — and aligned with sendListingMedia's own
    // 3-listing cap, which previously meant a lead could get 10 cards but 3
    // sets of photos.
    const { listings, relaxed } = await rankPropertiesForLead(searchFilters, {
        limit: MAX_LISTINGS_SHOWN,
        lang,
        // Things they've already turned down sink to the bottom rather than
        // being offered again as if new.
        rejectedIds: profile?.rejected_property_ids || [],
        lockType,
    });

    if (listings.length === 0) {
        // Worth recording as its own event: "how often does the catalogue
        // fail a real request?" is the single most useful signal about what
        // inventory to acquire next.
        await recordEvent(leadId, EVENT_TYPES.SEARCH_RETURNED_NOTHING, {
            metadata: { filters: searchFilters },
        });
        return { text: await composeNoResults({ lang, userMessage, history }), mediaListings: null };
    }

    // Claude writes ONLY the intro line; the listing cards and the booking
    // prompt stay template-rendered so no price or property detail can ever
    // be model-invented.
    const intro = await composeResultsIntro({
        lang, userMessage, listings, relaxed, filters: searchFilters, history,
    });
    const text = `${intro}\n\n${formatListingsBody(listings, lang)}\n\n${BOT_STRINGS.booking_prompt[lang]}`;
    // Remember which listings were shown (in the same numbered order) so a
    // reply like "2" resolves to a specific property.
    await setPendingViewingSelection(leadId, listings.map((p) => p.id));
    await recordShownListings(leadId, listings.map((p) => p.id));
    await recordEvent(leadId, EVENT_TYPES.PROPERTIES_SHOWN, {
        metadata: { propertyIds: listings.map((p) => p.id), relaxed },
    });
    return { text, mediaListings: listings };
};

// ── Booking flow, step 1: which listing (or decline)? ──
// Returns { text, mediaListings } rather than a bare string, because this is
// the one path where the lead can ask to SEE more of a listing — and the
// media send has to happen in handleMessage (which owns the WhatsApp
// connection). mediaListings is null unless media was requested.
// handleViewingDateTimeReply still returns a plain string; nothing in the
// date/time step can request media.
const handleViewingSelectionReply = async ({ leadId, text, lang, pendingListingIds, history = [], leadName = null }) => {
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
                    lang, userMessage: text, ...listingAnswerFacts(property, lang), history, stillNeeded: 'viewing_for_named',
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

    // Pushback on the whole set. §32: an objection is information, not a
    // rejection — the flow stays alive and we narrow the gap.
    if (selection.decision === 'objection') {
        await recordEvent(leadId, EVENT_TYPES.OBJECTION_RAISED, {
            metadata: { type: selection.objection_type || 'unstated' },
        });

        // Price is the one objection we can act on without asking anything:
        // they've seen these prices and said they're too high, so the useful
        // reply is cheaper options, not "what's your budget?" — a question
        // they'd reasonably feel they just answered.
        if (selection.objection_type === 'price') {
            const shown = (await Promise.all(pendingListingIds.map((id) => getPropertyById(id)))).filter(Boolean);
            const cheapestShown = shown.length ? Math.min(...shown.map((p) => p.price)) : null;
            if (cheapestShown) {
                // Strictly below the cheapest they rejected — anything at or
                // above it is the same answer again.
                await mergeProfile(leadId, {
                    deltas: { budget_max: Math.max(1, cheapestShown - 1) },
                    clearedFields: ['budget_stretch_max'],
                });
            }
            // Re-search immediately against the profile we JUST updated —
            // same reasoning as the single-listing price rejection above.
            // lockType keeps type/transaction/city/neighbourhood/bedrooms
            // exactly as stated; only the ceiling moves.
            const updatedProfile = await getProfile(leadId);
            return performSearchAndRespond(leadId, updatedProfile, {
                lang, history, userMessage: text, lockType: true,
            });
        }

        return {
            text: await composeObjection({
                lang, userMessage: text, objectionType: selection.objection_type, history,
            }),
            mediaListings: null,
        };
    }

    // "Compare 1 and 3". Stays in the selection state — comparing is how they
    // decide, not a decision. The table is rendered from the DB rows; only the
    // one-line steer underneath is composed.
    if (selection.decision === 'compare') {
        const wanted = (selection.compare_numbers && selection.compare_numbers.length >= 2)
            ? selection.compare_numbers
            // "compare them" with nothing named — use everything on screen.
            : pendingListingIds.map((_, i) => i + 1);

        const ids = wanted
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= pendingListingIds.length)
            .slice(0, 3) // beyond three, a WhatsApp message stops being readable
            .map((n) => pendingListingIds[n - 1]);

        const properties = (await Promise.all(ids.map((id) => getPropertyById(id)))).filter(Boolean);

        // Fewer than two survived (a listing was deleted mid-conversation) —
        // there is nothing to compare, so fall through to the normal handling
        // rather than showing a one-column "comparison".
        if (properties.length >= 2) {
            const profile = await getProfile(leadId);
            // Only priorities they ACTUALLY stated. Passing an empty list makes
            // the composer ask what matters instead of inventing a preference.
            const stated = [
                profile?.budget_max || profile?.budget_stretch_max ? (lang === 'fr' ? 'leur budget' : 'their budget') : null,
                profile?.neighbourhood ? (lang === 'fr' ? `le quartier ${profile.neighbourhood}` : `the ${profile.neighbourhood} area`) : null,
                profile?.bedrooms_min ? (lang === 'fr' ? 'le nombre de chambres' : 'the number of bedrooms') : null,
                profile?.purpose === 'investment' ? (lang === 'fr' ? "l'investissement" : 'investment potential') : null,
            ].filter(Boolean).join(', ');

            const table = formatComparison(properties, lang);
            const steer = await composeComparison({
                lang,
                userMessage: text,
                // The fact sheet (with descriptions), not the visible table —
                // so the steer can name what actually differentiates them
                // without reconstructing details from the transcript.
                summary: comparisonFactSheet(properties, lang),
                statedPriorities: stated || null,
                history,
            });
            await recordEvent(leadId, EVENT_TYPES.PROPERTIES_COMPARED, {
                metadata: { propertyIds: properties.map((p) => p.id) },
            });
            return { text: `${table}\n\n${steer}`, mediaListings: null };
        }
    }

    // They turned ONE listing down. Not a decline — they're still shopping, so
    // the flow stays alive. Record it (so it sinks in future rankings) and
    // either use the reason they gave or ask for it, because "which part didn't
    // work" is what makes the next set better rather than just different.
    if (
        selection.decision === 'reject_property' &&
        Number.isInteger(selection.selected_number) &&
        selection.selected_number >= 1 &&
        selection.selected_number <= pendingListingIds.length
    ) {
        const propertyId = pendingListingIds[selection.selected_number - 1];
        await recordInterest(leadId, propertyId, { liked: false });
        await recordEvent(leadId, EVENT_TYPES.PROPERTY_REJECTED, {
            propertyId, metadata: { reason: selection.rejection_reason || 'unstated' },
        });

        if (selection.rejection_reason) {
            await recordRejectionReason(leadId, propertyId, selection.rejection_reason);

            // "Too expensive" has to move the budget, not just sink the
            // listing. Without this, rejecting the CHEAPEST option on price
            // simply promoted the dearer ones — the bot answering "that's too
            // expensive" with something costlier, which is the opposite of
            // listening. Same rule as the whole-set price objection below.
            if (selection.rejection_reason === 'price') {
                const rejectedProperty = await getPropertyById(propertyId);
                if (rejectedProperty) {
                    await mergeProfile(leadId, {
                        deltas: { budget_max: Math.max(1, rejectedProperty.price - 1) },
                        clearedFields: ['budget_stretch_max'],
                    });
                }

                // Re-search immediately against the profile we JUST updated —
                // not a second NLU pass over "too expensive" itself (see
                // performSearchAndRespond). lockType keeps property_type,
                // transaction, city, neighbourhood and bedrooms exactly as
                // they were: a price rejection narrows the budget, it does
                // not relax what kind of place they asked for.
                const updatedProfile = await getProfile(leadId);
                return performSearchAndRespond(leadId, updatedProfile, {
                    lang, history, userMessage: text, lockType: true,
                });
            }

            // A non-price reason ("too far", "too small") isn't something we
            // can act on programmatically — re-searching now beats
            // interrogating them, but only a fresh understanding pass can
            // tell us what to change. Returning null hands control back to
            // the search path.
            return null;
        }

        const property = await getPropertyById(propertyId);
        const propertyLabel = property
            ? `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`
            : '';
        return {
            text: await composeAskRejectionReason({ lang, userMessage: text, propertyLabel, history }),
            mediaListings: null,
        };
    }

    // Needs a person. Escalates WITHOUT clearing the pending state — they may
    // still want to view something once a colleague has answered them.
    if (selection.decision === 'wants_human') {
        await flagForHuman(leadId, selection.handoff_reason || 'asked_for_agent');
        return {
            text: await composeHandoff({ lang, userMessage: text, reason: selection.handoff_reason, history }),
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
            // Saying they like one is a real preference signal — record it
            // here, from the booking NLU's own output, rather than running a
            // second understanding call mid-flow just to learn the same thing.
            await recordInterest(leadId, propertyId, { liked: true });
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
        // Choosing one to view is the strongest interest signal there is.
        await recordInterest(leadId, propertyId, { liked: true });
        const property = await getPropertyById(propertyId);
        const propertyLabel = property
            ? `${PROPERTY_TYPE_LABELS[property.type]?.[lang] ?? property.type} — ${property.neighbourhood}, ${property.city}`
            : '';
        return { text: await composeAskDatetime({ lang, propertyLabel, history, needsName: !leadName }), mediaListings: null };
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
            return { text: await composeAskDatetime({ lang, propertyLabel, history, needsName: !leadName }), mediaListings: null };
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

    // Before giving up: a general property question asked mid-booking lands
    // here, because the selection NLU is only looking for a choice between
    // listings. "What is a cour commune?" is not unclear — it just wasn't a
    // selection. A free keyword lookup rescues it, and the booking survives.
    const midFlowFacts = findKnowledge(text);
    if (midFlowFacts.length) {
        await recordEvent(leadId, EVENT_TYPES.QUESTION_ANSWERED, {
            metadata: { matched: midFlowFacts.map((f) => f.id), midFlow: true },
        });
        return {
            text: await composeKnowledgeAnswer({
                lang, userMessage: text, facts: knowledgeBlock(midFlowFacts, lang), history,
            }),
            mediaListings: null,
        };
    }

    // Genuinely couldn't tell which listing they meant.
    await recordEvent(leadId, EVENT_TYPES.NOT_UNDERSTOOD);

    // Three in a row means rephrasing is not working, and asking a fourth time
    // is just wasting their patience — one of the doc's explicit escalation
    // triggers. Based on a fact (we failed three times) rather than an
    // inference about how they feel.
    const consecutiveFailures = await countTrailingEvents(leadId, EVENT_TYPES.NOT_UNDERSTOOD, 5);
    if (consecutiveFailures >= REPEATED_MISUNDERSTANDING_LIMIT) {
        await flagForHuman(leadId, 'repeated_misunderstanding');
        return {
            text: await composeHandoff({ lang, userMessage: text, reason: 'repeated_misunderstanding', history }),
            mediaListings: null,
        };
    }

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
    // If we just asked for it (or they gave it unprompted), save it. COALESCE
    // inside means this can only ever fill a blank, never overwrite a name
    // already on file.
    await updateLeadNameIfMissing(leadId, result.stated_name);
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

    // Needs a person. Escalate but DO NOT touch the pending state — they were
    // arranging a viewing and asking about price or an agent doesn't undo
    // that. Only an explicit decline ends a booking.
    if (result.decision === 'wants_human') {
        await flagForHuman(leadId, result.handoff_reason || 'asked_for_agent');
        return {
            text: await composeHandoff({ lang, userMessage: text, reason: result.handoff_reason, history }),
            mediaListings: null,
        };
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
                lang, userMessage: text, ...listingAnswerFacts(property, lang), history, stillNeeded: 'date',
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

    // Both writes or neither: a crash between them used to leave a booked
    // appointment with the lead still parked in 'awaiting_viewing_datetime',
    // so their next message would be read as a date for a viewing they had
    // already successfully booked.
    await pool.withTransaction(async (client) => {
        await createAppointment({
            leadId,
            propertyId,
            requestedText: text,
            requestedDatetime: result.iso_datetime,
            requestedDate: result.resolved_date,
            requestedTimeOfDay: result.time_of_day,
            client,
        });
        await clearPendingAction(leadId, client);
        await recordEvent(leadId, EVENT_TYPES.SITE_VISIT_BOOKED, { propertyId, metadata: { requestedText: text } }, client);
    });

    // Outside the transaction: a notification failing must not roll back a
    // booking the lead has already been told about. Every viewing request is
    // worth surfacing, so no dedupe window here.
    await createNotification({
        leadId,
        type: 'appointment_booked',
        title: 'New viewing request',
        detail: propertyLabel ? `${propertyLabel} — "${text}"` : text,
        dedupeWindowHours: 0,
    });

    // Wrapper is composed; the factual recap underneath stays deterministic.
    const confirmation = await composeBookingConfirmed({ lang, history });
    return { text: `${confirmation}

${propertyLabel}
${text}`, mediaListings: null };
};

// Saves a bot reply to the conversation log, swallowing its own errors
// (best-effort logging must never mask the original failure or block a send).
const logBotReply = async (leadId, replyText) => {
    if (!leadId) return;
    try {
        await saveConversationMessage(leadId, 'bot', replyText);
    } catch (logError) {
        console.error('Failed to save bot reply to conversations:', logError.message);
    }
};

// ── processInboundMessage ──
// THE bot. Everything from "a lead said something" to "here is what to say
// back" lives here: lead state, memory, language, NLU, booking flow, search,
// composition — and it persists both sides of the exchange.
//
// It deliberately does NOT send anything. Transport (WhatsApp Graph API calls)
// and the HTTP envelope belong to handleMessage below. That split exists so
// scripts/smoke-bot.js can drive the REAL decision path end to end without
// sending messages — before this split it had to re-implement the routing
// below to test it, which meant the suite could stay green while production
// diverged. See the header comment in smoke-bot.js for why that matters here.
//
// Never throws: on failure it returns the bilingual error fallback, so the
// caller always has something to send.
const processInboundMessage = async ({ phone, text: rawText, contactName = null, messageType = 'text' }) => {
    let lang = DEFAULT_LANGUAGE;
    let leadId = null;

    try {
        const text = rawText?.trim();
        const existingLeadState = await getLeadState(phone);

        // The bot's short-term memory. Loaded BEFORE the lead row is touched
        // so the current message isn't in it yet — history is strictly "what
        // was said before now".
        const history = existingLeadState
            ? await getRecentConversation(existingLeadState.id, HISTORY_TURNS)
            : [];

        // Long-term memory: everything this lead has ever told us about what
        // they want, as structured data. The transcript above is a 10-row
        // window; this is not.
        const existingProfile = existingLeadState
            ? await getProfile(existingLeadState.id)
            : null;

        // Non-text message (image, sticker, voice note, ...) — we can't read
        // it, but it's still a real contact: log it and reply.
        //
        // A media message carries NO language signal, so we reply in the
        // lead's ALREADY-KNOWN language and pass null so getOrCreateLead
        // preserves it. Previously this defaulted to French and *wrote* that
        // default, which silently flipped an English conversation to French
        // for good the moment someone sent a photo.
        if (messageType !== 'text' || !text) {
            lang = existingLeadState?.language || DEFAULT_LANGUAGE;
            ({ id: leadId } = await getOrCreateLead(phone, contactName, null));
            await saveConversationMessage(leadId, 'user', `[unsupported message type: ${messageType}]`);
            const mediaReply = await composeUnsupportedMedia({ lang, mediaType: messageType });
            await logBotReply(leadId, mediaReply);
            return { replyText: mediaReply, mediaListings: null, lang, leadId };
        }

        // Free regex fast path for the unambiguous phrasings ("english",
        // "en français"). It's deliberately NOT the only mechanism — it misses
        // natural wordings like "now please english", which is why the NLU
        // below also reports language_request.
        const regexSwitchRequest = detectLanguageSwitchRequest(text);

        // Mid-booking replies are slot-fills ("1", "tomorrow 11am") and go to
        // the dedicated booking NLUs, so the general understanding call is
        // skipped there — no wasted round-trip.
        //
        // Kept deliberately, despite the profile now existing. Running the
        // general NLU here too would add a second Claude call on the most
        // latency-sensitive path, re-expose the FR/EN flip-flopping that the
        // short-message guard below was written to stop, and — worst — let a
        // slot-fill like "1" or "tomorrow 11am" hallucinate filters that then
        // get merged into the saved profile. The profile is updated mid-flow
        // from the booking NLU's own output instead (see below), which needs
        // no extra call.
        const inPendingFlow = Boolean(existingLeadState?.pendingAction);
        let understanding = inPendingFlow ? null : await extractSearchFilters(text, history, existingProfile);

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

        const lead = await getOrCreateLead(phone, contactName, lang);
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
                leadName: lead.name,
            });
            // null = "this wasn't a selection, they're searching again".
            // Load the understanding we skipped and fall through to search.
            if (selectionResult === null) {
                understanding = await extractSearchFilters(text, history, existingProfile);
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

            // Passive capture — most people never volunteer their name here,
            // but if they do ("Hi, I'm Kofi..."), take it for free. COALESCE
            // inside means it can never overwrite a name already on file.
            await updateLeadNameIfMissing(leadId, filters.stated_name);

            // Everything the lead has told us, merged into one durable picture:
            // what they said before, plus whatever this message added or
            // retracted. Written BEFORE the search so the search runs against
            // the full requirement rather than just this message's fragment —
            // "under 300000" now searches villas in Lomé under 300000, because
            // the villa and the Lomé came from previous turns.
            await mergeProfile(leadId, {
                deltas: {
                    transaction: filters.transaction,
                    property_type: filters.type,
                    city: filters.city,
                    neighbourhood: filters.neighbourhood,
                    // A single stated bedroom count fills both ends of the range.
                    bedrooms_min: filters.bedrooms_min ?? filters.bedrooms,
                    bedrooms_max: filters.bedrooms_max ?? filters.bedrooms,
                    budget_max: filters.price_max,
                    budget_stretch_max: filters.budget_stretch_max,
                    purpose: filters.purpose,
                    timeline: filters.timeline,
                    // A real value naming an actual area/budget supersedes an
                    // earlier "no preference" — force the flag off (`false`,
                    // not `null`) rather than leaving it stuck true forever.
                    // Otherwise pass through whatever this message signalled
                    // (`true` or `null` — never a bare `false` from the NLU).
                    neighbourhood_no_preference: filters.neighbourhood ? false : filters.neighbourhood_no_preference,
                    budget_no_preference: filters.price_max ? false : filters.budget_no_preference,
                },
                clearedFields: filters.cleared_fields || [],
            });
            const profile = await getProfile(leadId);

            // ONE decision, made in code. See utils/nextBestAction.js — the
            // rule ordering is the bot's goal hierarchy, and keeping it out of
            // a prompt is what makes it exhaustively testable.
            const { action } = nextBestAction({
                pendingAction: null, // pending flows were already handled above
                intent: filters.intent,
                languageSwitchRequest,
                profile,
            });

            if (action === ACTIONS.HANDOFF) {
                // Flag FIRST, then reply. The composer is allowed to say "I'm
                // passing this on" only because this line has already made it
                // true — reversing the order would make the bot's promise
                // conditional on a write that might fail.
                await flagForHuman(leadId, filters.handoff_reason || 'asked_for_agent', {
                    leadName: contactName, leadPhone: phone,
                });
                replyBody = await composeHandoff({
                    lang, userMessage: text, reason: filters.handoff_reason, history,
                });
                isGreetingReply = true; // a handover is not a moment to also welcome them
            } else if (action === ACTIONS.ANSWER_QUESTION) {
                // Answer from the curated knowledge base, or admit we don't
                // know. Never from the model's own sense of how Togolese
                // property law and deposits work.
                const facts = findKnowledge(text);
                replyBody = facts.length
                    ? await composeKnowledgeAnswer({
                        lang, userMessage: text, facts: knowledgeBlock(facts, lang), history,
                    })
                    : BOT_STRINGS.knowledge_unknown[lang];
                await recordEvent(leadId, EVENT_TYPES.QUESTION_ANSWERED, {
                    metadata: { matched: facts.map((f) => f.id) },
                });
                // Answering is not a welcome, and a question is not a reason to
                // start a fresh introduction.
                isGreetingReply = true;
            } else if (action === ACTIONS.SWITCH_LANGUAGE) {
                // They only asked to change language — confirm in the NEW
                // language, rather than treating "now please english" as
                // off-topic or dumping listings at them. A switch bundled WITH
                // a request ("show me villas in english") falls through to the
                // search below, which renders in the new language anyway.
                replyBody = await composeLanguageSwitch({ lang, history });
                isGreetingReply = true;
            } else if (action === ACTIONS.CLOSE) {
                // "Thank you" / "merci" / "ok bye". Must NOT be answered with a
                // welcome — that was the most robotic-looking failure in
                // testing (thanking the bot after booking got a full greeting).
                const justBooked = history.some((m) => m.sender === 'bot' && m.message.includes(BOT_STRINGS.booking_confirmed[lang]))
                    || Boolean(existingLeadState && !existingLeadState.pendingAction && history.length > 2);
                replyBody = await composeClosing({ lang, userMessage: text, history, justBooked });
                isGreetingReply = true;
            } else if (action === ACTIONS.ASK_WHAT_THEY_WANT) {
                // They want to book but no listings are pending — they haven't
                // been shown anything yet, so find out what they want first.
                replyBody = await composeGreeting({ lang, userMessage: text, isNewLead: lead.isNew, history });
                isGreetingReply = true;
            } else if (action === ACTIONS.ANSWER_OFF_TOPIC) {
                replyBody = await composeOffTopic({ lang, userMessage: text, history });
            } else if (action === ACTIONS.GREET) {
                // A pure greeting with no property information — welcome them
                // and invite a requirement. Already a full welcome on its own,
                // so it never gets the welcome_prefix below.
                replyBody = await composeGreeting({ lang, userMessage: text, isNewLead: lead.isNew, history });
                isGreetingReply = true;
            } else if (action === ACTIONS.ASK_NEIGHBOURHOOD) {
                // City + type are known, neighbourhood isn't — ask before
                // searching rather than showing results on partial criteria.
                // cityLabel/typeLabel are DETERMINISTIC facts pulled straight
                // from the profile, handed to the composer as an anchor so it
                // can ask naturally ("a villa in Lomé — which area...") without
                // inventing or restating anything itself.
                replyBody = await composeAskNeighbourhood({
                    lang, userMessage: text, cityLabel: profile.city,
                    typeLabel: PROPERTY_TYPE_LABELS[profile.property_type]?.[lang] ?? profile.property_type,
                    history,
                });
            } else if (action === ACTIONS.ASK_BUDGET) {
                // Neighbourhood is settled (a value, or explicit "no
                // preference") — ask for budget next, still before searching.
                replyBody = await composeAskBudget({
                    lang, userMessage: text, cityLabel: profile.city,
                    typeLabel: PROPERTY_TYPE_LABELS[profile.property_type]?.[lang] ?? profile.property_type,
                    neighbourhoodLabel: profile.neighbourhood || null,
                    history,
                });
            } else {
                // SEARCH_AND_SHOW. Real intent, even if vague ("anything
                // cheap?"). An empty filter set is NOT a reason to re-greet
                // someone who just asked a genuine question — search anyway,
                // which with no filters returns the cheapest listings.
                //
                // See performSearchAndRespond above — same helper the
                // price-driven rejection/objection re-search uses (below),
                // just without lockType: a plain search keeps property type
                // as the usual soft criterion, exactly as before.
                const searchResult = await performSearchAndRespond(leadId, profile, {
                    lang, history, userMessage: text,
                });
                replyBody = searchResult.text;
                listingsShown = searchResult.mediaListings;
            }
        }

        // First-ever reply to a brand-new lead always opens with a welcome,
        // per CLAUDE.md's "first message from a new number → welcome
        // message" — but we still answer whatever they actually asked
        // rather than making them repeat themselves on a second turn.
        const replyText = (lead.isNew && !isGreetingReply)
            ? `${BOT_STRINGS.welcome_prefix[lang]}\n\n${replyBody}`
            : replyBody;

        await logBotReply(leadId, replyText);

        // Recompute score, temperature and pipeline status from everything we
        // now know. Last, so it sees this turn's profile changes and any
        // appointment just created. Best-effort inside — derived analytics must
        // never be why a lead doesn't get answered.
        await refreshLeadSignals(leadId, { leadName: contactName, leadPhone: phone });

        return { replyText, mediaListings: listingsShown, lang, leadId };
    } catch (error) {
        console.error('Error handling incoming message:', error);
        const replyText = BOT_STRINGS.error_fallback[lang];
        await logBotReply(leadId, replyText);
        return { replyText, mediaListings: null, lang, leadId };
    }
};

// ── Handle incoming message ──
// The webhook envelope only: unwrap Meta's payload, enforce idempotency, hand
// the actual message to processInboundMessage, then transmit whatever it
// decided. No bot logic lives here — see processInboundMessage above.
const handleMessage = async (req, res) => {
    let to = null;

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

        const { replyText, mediaListings, lang, leadId } = await processInboundMessage({
            phone: to,
            text: message.text?.body,
            contactName: value?.contacts?.[0]?.profile?.name || null,
            messageType: message.type,
        });

        await sendWhatsAppMessage(to, replyText);

        // Photos follow the text card as separate messages, per CLAUDE.md's
        // WhatsApp message-type rules — text first, then image calls, never
        // combined. Only for listings that actually have photos uploaded.
        if (mediaListings) {
            await sendListingMedia(to, leadId, mediaListings, lang);
        }

        return res.sendStatus(200);
    } catch (error) {
        // processInboundMessage never throws, so reaching here means the
        // envelope, the idempotency write, or the send itself failed.
        console.error('Error handling incoming message:', error);
        if (to) {
            try {
                await sendWhatsAppMessage(to, BOT_STRINGS.error_fallback[DEFAULT_LANGUAGE]);
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
    processInboundMessage,
    handleViewingSelectionReply,
    handleViewingDateTimeReply,
    extractSearchFilters,
    hasAnyFilter,
    formatListingsBody,
    formatListingsSummary,
    formatComparison,
    extractViewingSelection,
    extractAppointmentDateTime,
};
