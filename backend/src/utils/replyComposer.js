const Anthropic = require('@anthropic-ai/sdk');
const { BOT_STRINGS, PROPERTY_TYPE_LABELS } = require('./language');

// ── The bot's conversational voice ──
//
// DESIGN RULE, do not break it: Claude writes ONLY the conversational wrapper
// (the opening line, any explanation of a widened search, the follow-up
// question). It NEVER writes property facts. Prices, neighbourhoods, types
// and the agency contact are rendered deterministically by the caller
// (formatListingsSummary in webhookController.js) and appended afterwards.
//
// That split is what makes this safe: the model literally cannot state a
// wrong price, because it never authors one. It's given the listings only so
// its wording stays consistent with what the lead is about to see.
//
// Every function here degrades to the hardcoded BOT_STRINGS on any failure —
// per CLAUDE.md, Claude failing must never stop the bot replying.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const COMPOSER_MODEL = 'claude-haiku-4-5-20251001';

const LANGUAGE_NAME = { fr: 'French', en: 'English' };

const BASE_PERSONA = `You are EXCELIA, a warm, professional WhatsApp assistant for a real estate agency in Togo (Lomé and surrounding areas).

Voice rules — follow ALL of them:
- Write ONLY the message body. No preamble, no quotes, no markdown headings, no bullet symbols like * or #.
- WhatsApp style: short. 1-3 sentences maximum unless told otherwise. Warm but efficient, never chatty or salesy.
- Never invent, guess, or restate a property price, address, size, or feature. You are given listing data ONLY so your wording matches what the customer is about to see below your message.
- Never imply the results match a criterion the customer did not actually state. If they named no area, do not say "in your area"; if they gave no budget, do not say "within your budget".
- Never promise anything on the agency's behalf (no discounts, no availability guarantees, no viewing times).
- Never mention that you are an AI, a model, or that you performed a database search.
- Plain text only. A single emoji is acceptable at most, and only in a greeting.`;

// Compact, token-cheap view of the listings — enough for the model to write
// naturally around them, without dumping every column.
const summariseListings = (listings, lang) =>
    listings
        .map((p, i) => {
            const typeLabel = PROPERTY_TYPE_LABELS[p.type]?.[lang] ?? p.type;
            const bedrooms = p.bedrooms ? `, ${p.bedrooms} bedroom(s)` : '';
            return `${i + 1}. ${typeLabel} in ${p.neighbourhood}, ${p.city}${bedrooms}`;
        })
        .join('\n');

// Human-readable description of what the search had to widen, so the model
// can explain it honestly rather than implying an exact match.
const describeRelaxation = (relaxed, filters) => {
    if (!relaxed || relaxed.length === 0) return '';
    const parts = [];
    if (relaxed.includes('neighbourhood') && filters.neighbourhood) parts.push(`the neighbourhood "${filters.neighbourhood}"`);
    if (relaxed.includes('bedrooms') && filters.bedrooms) parts.push(`exactly ${filters.bedrooms} bedroom(s)`);
    if (relaxed.includes('type') && filters.type) parts.push(`the property type they asked for`);
    if (relaxed.includes('city') && filters.city) parts.push(`the city "${filters.city}"`);
    if (relaxed.includes('price_max') && filters.price_max) parts.push(`their stated budget`);
    if (parts.length === 0) return '';
    return `IMPORTANT: there was no exact match. You had to widen the search — these results do NOT match ${parts.join(' and ')}. Acknowledge this honestly and briefly in your opening line, so the customer is not misled into thinking these are exact matches.`;
};

const callComposer = async (systemPrompt, userPrompt, fallback) => {
    try {
        const response = await anthropic.messages.create({
            model: COMPOSER_MODEL,
            max_tokens: 300,
            temperature: 0.5, // a little warmth/variety, still tightly constrained
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
        });
        const text = response.content
            ?.filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();
        return text || fallback;
    } catch (error) {
        console.error('replyComposer failed, using hardcoded fallback:', error.message);
        return fallback;
    }
};

// ── composeResultsIntro ──
// The line(s) that appear ABOVE the deterministic listing cards.
const composeResultsIntro = async ({ lang, userMessage, listings, relaxed, filters }) => {
    const relaxationNote = describeRelaxation(relaxed, filters);
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: write the SHORT opening line that appears directly above a numbered list of properties the customer is about to see. Do not list or describe the properties yourself — they are shown right below your line. Do not repeat their prices or locations.`;

    const user = `The customer wrote: "${userMessage}"

${listings.length} matching propert${listings.length === 1 ? 'y is' : 'ies are'} about to be shown to them, in this order:
${summariseListings(listings, lang)}

${relaxationNote}

Write only the opening line.`;

    return callComposer(system, user, BOT_STRINGS.results_intro[lang]);
};

// ── composeNoResults ──
// Genuinely nothing in the catalogue matched, even after widening.
const composeNoResults = async ({ lang, userMessage }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: tell the customer nothing currently matches, then ask ONE specific, useful follow-up question that would help you find something (for example about their budget, preferred area, or property type — pick whichever they did NOT already tell you). Do not apologise more than once.`;

    const user = `The customer wrote: "${userMessage}"

Nothing in the current catalogue matches. Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.no_results[lang]);
};

// ── composeGreeting ──
// First contact, or a message with no usable search information at all.
const composeGreeting = async ({ lang, userMessage, isNewLead }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: greet the customer${isNewLead ? ' (this is their very first message to us)' : ''} and invite them to say what they are looking for. Mention naturally that they can tell you the area, the type of property, their budget, or the number of bedrooms — do not present this as a rigid list or a form.`;

    const user = `The customer wrote: "${userMessage}"

Write the greeting.`;

    return callComposer(system, user, BOT_STRINGS.welcome_clarify[lang]);
};

// ── composeOffTopic ──
const composeOffTopic = async ({ lang, userMessage }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer asked about something unrelated to property. Politely and briefly steer back to what you can help with — finding a property in Togo. Do not be preachy or repeat their off-topic question back at length.`;

    const user = `The customer wrote: "${userMessage}"

Write the redirect.`;

    return callComposer(system, user, BOT_STRINGS.off_topic[lang]);
};

// ── composeUnsupportedMedia ──
// They sent an image/sticker/voice note. Answer in THEIR language.
const composeUnsupportedMedia = async ({ lang, mediaType }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer sent a ${mediaType} that you cannot read. Briefly say you can only read text right now, and invite them to type what they are looking for. Keep it light — do not make them feel they did something wrong.`;

    const user = `Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.unsupported_message_type[lang]);
};

module.exports = {
    composeResultsIntro,
    composeNoResults,
    composeGreeting,
    composeOffTopic,
    composeUnsupportedMedia,
};
