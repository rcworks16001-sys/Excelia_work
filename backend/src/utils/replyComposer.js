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
- CRITICAL — never state or imply that an action has been taken unless THIS prompt explicitly tells you it was. Do not say a viewing is booked, confirmed, registered, or passed to the team, and do not say anyone will call them back, unless you are told so here. The conversation history may show a customer ASKING to book; that is not the same as a booking existing. If you are unsure whether something happened, do not mention it at all.
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
    // Showing a buyer rental listings (or vice versa) is the widening most
    // likely to waste their time — say it plainly, not as "the type".
    if (relaxed.includes('transaction') && filters.transaction) {
        parts.push(filters.transaction === 'sale'
            ? 'being for sale (these are rentals)'
            : 'being for rent (these are for sale)');
    }
    if (relaxed.includes('city') && filters.city) parts.push(`the city "${filters.city}"`);
    if ((relaxed.includes('price_max') && filters.price_max)
        || (relaxed.includes('price_ceiling') && filters.price_ceiling)) parts.push(`their stated budget`);
    if (parts.length === 0) return '';
    return `IMPORTANT: there was no exact match. You had to widen the search — these results do NOT match ${parts.join(' and ')}. Acknowledge this honestly and briefly in your opening line, so the customer is not misled into thinking these are exact matches.`;
};

// Renders the stored transcript as readable dialogue, and — crucially —
// instructs the model not to repeat itself. Without this the bot re-sent the
// same welcome/question every few turns, which is what made it feel robotic.
const historyBlock = (history = []) => {
    if (!history.length) return '';
    const lines = history
        .map((m) => `${m.sender === 'bot' ? 'You (EXCELIA)' : 'Customer'}: ${m.message}`)
        .join('\n');
    return `

CONVERSATION SO FAR (oldest first) — you have already said these things:
${lines}

Rules given this history:
- Do not re-introduce yourself or re-explain what EXCELIA does — you have already met this customer. Greeting them back politely is still fine and expected; just keep it brief and word it differently from last time.
- NEVER re-ask something they have already answered.
- Vary your wording; do not reuse a sentence you already used above.
- If you need to ask again for something you already asked for, REPHRASE it and first acknowledge whatever just happened. Never restate your previous question word for word.
- Refer naturally to what they already told you where it helps.`;
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

// What the flow is still waiting on, so a mid-flow interruption ends by
// picking the thread back up rather than leaving the lead hanging — phrased
// as guidance so the model rewords it instead of repeating itself.
const stillNeededLine = (stillNeeded) => {
    if (stillNeeded === 'date') return '\n\nEnd by inviting them, in a FRESH wording, to tell you a day and time that suits them. Do not repeat your earlier phrasing of that question, and do not ask which property — they have already chosen one.';
    if (stillNeeded === 'selection') return '\n\nEnd by inviting them, in a FRESH wording, to tell you which property they would like (by number). Do not repeat your earlier phrasing of that question.';
    return '';
};

// ── composeConfirmBooking ──
// They signalled a preference ("the first one looks good") rather than asking
// to book. Liking a property is not the same as booking a viewing, so we
// confirm intent BEFORE asking for a date.
const composeConfirmBooking = async ({ lang, propertyLabel, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer indicated they like one of the properties, but has NOT asked to book anything. Acknowledge their choice warmly, then ASK whether they would like you to arrange a viewing for it. One or two short sentences.

Do NOT ask for a date or time yet — you must not assume they want to book. Do NOT say anything is booked or arranged.

You may refer to the property as: "${propertyLabel}". Do not state its price or any other detail.${historyBlock(history)}`;

    const user = 'Write the reply.';

    return callComposer(system, user, BOT_STRINGS.confirm_booking[lang]);
};

// ── composeListingAnswer ──
// They asked something about a property ("what is the price again?").
// The full property card is appended by the caller, so the model must not
// restate any figure itself.
const composeListingAnswer = async ({ lang, userMessage, propertyCard, history, stillNeeded }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer asked a question about a property. The property's full details are printed directly beneath your message, so answer by pointing them to it in ONE short sentence — do NOT state the price, location, or any other figure yourself.${stillNeededLine(stillNeeded)}${historyBlock(history)}`;

    const user = `The customer asked: "${userMessage}"

Write your line (the details below it are handled for you).`;

    const line = await callComposer(system, user, BOT_STRINGS.listing_answer[lang]);
    return `${line}\n\n${propertyCard}`;
};

// ── composeMidFlowAcknowledgement ──
// A greeting or a thanks arriving in the middle of a booking. They have
// already met us — never re-welcome or re-introduce.
const composeMidFlowAcknowledgement = async ({ lang, userMessage, history, stillNeeded, listingCount }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer sent a greeting or a pleasantry in the MIDDLE of an ongoing booking conversation. Acknowledge it warmly in a few words. You have already greeted this customer — do NOT welcome them, introduce yourself, or explain what you do again.${listingCount ? ` They are currently looking at ${listingCount} properties you already sent them; do not re-send or re-describe those.` : ''}${stillNeededLine(stillNeeded)}${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.midflow_ack[lang]);
};

// ── composeResultsIntro ──
// The line(s) that appear ABOVE the deterministic listing cards.
const composeResultsIntro = async ({ lang, userMessage, listings, relaxed, filters, history }) => {
    const relaxationNote = describeRelaxation(relaxed, filters);
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: write the SHORT opening line that appears directly above a numbered list of properties the customer is about to see. Do not list or describe the properties yourself — they are shown right below your line. Do not repeat their prices or locations.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

${listings.length} matching propert${listings.length === 1 ? 'y is' : 'ies are'} about to be shown to them, in this order:
${summariseListings(listings, lang)}

${relaxationNote}

Write only the opening line.`;

    return callComposer(system, user, BOT_STRINGS.results_intro[lang]);
};

// ── composeNoResults ──
// Genuinely nothing in the catalogue matched, even after widening.
const composeNoResults = async ({ lang, userMessage, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: tell the customer nothing currently matches, then ask ONE specific, useful follow-up question that would help you find something (for example about their budget, preferred area, or property type — pick whichever they did NOT already tell you). Do not apologise more than once.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Nothing in the current catalogue matches. Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.no_results[lang]);
};

// ── composeGreeting ──
// First contact, or a message with no usable search information at all.
const composeGreeting = async ({ lang, userMessage, isNewLead, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: ALWAYS open with a warm greeting — never jump straight into a question. ${isNewLead
        ? 'This is their very first message to us, so welcome them to EXCELIA properly.'
        : 'They have contacted us before, so greet them back warmly like a returning customer ("Hello again!" / "Bonjour, ravi de vous revoir !") WITHOUT repeating the full introduction.'} Then invite them to say what they are looking for, mentioning naturally that they can tell you the area, the type of property, their budget, or the number of bedrooms — never as a rigid list or a form.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the greeting.`;

    return callComposer(system, user, BOT_STRINGS.welcome_clarify[lang]);
};

// ── composeOffTopic ──
const composeOffTopic = async ({ lang, userMessage, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer asked about something unrelated to property. Politely and briefly steer back to what you can help with — finding a property in Togo. Do not be preachy or repeat their off-topic question back at length.${historyBlock(history)}`;

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

// ── composeLanguageSwitch ──
// They asked to be spoken to in another language. `lang` is the NEW language.
const composeLanguageSwitch = async ({ lang, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer just asked you to switch to this language. Briefly and warmly confirm you're switching. If they have already told you what they're looking for, acknowledge that instead of asking again from scratch; only ask what they need if you genuinely don't know yet. One short sentence, two at most. Do not apologise.${historyBlock(history)}`;

    const user = 'Write the confirmation.';

    return callComposer(system, user, BOT_STRINGS.language_switched[lang]);
};

// ── composeClosing ──
// "Thank you", "merci", "ok bye". Previously classified as a greeting, which
// is why thanking the bot after a completed booking returned a full welcome
// message — the single most robotic-looking failure in testing.
const composeClosing = async ({ lang, userMessage, history, justBooked }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer is thanking you or wrapping up. Reply the way a professional agent would close a conversation: acknowledge warmly, in ONE short sentence, and let them know they can message any time if they need anything else.

ABSOLUTELY DO NOT greet them, welcome them, introduce yourself, or ask what they are looking for. The conversation is ending, not starting.${justBooked ? '\nA viewing request was just registered for them, so it is natural to reassure them the office will follow up about it.' : ''}${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the closing reply.`;

    return callComposer(system, user, BOT_STRINGS.closing[lang]);
};

// ── composeBookingPrompt ──
// They want to book but haven't said which listing.
const composeBookingPrompt = async ({ lang, listingCount, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer has said they'd like to book a viewing, but hasn't said WHICH of the ${listingCount} properties you showed them. Acknowledge their interest positively, then ask which one they'd like to see, mentioning they can just reply with its number. One or two short sentences. Do not imply they were unclear or that you didn't understand them — they were perfectly clear.${historyBlock(history)}`;

    const user = 'Write the reply.';

    return callComposer(system, user, BOT_STRINGS.booking_prompt[lang]);
};

// ── composeAskDatetime ──
const composeAskDatetime = async ({ lang, propertyLabel, history, isReAsk }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: ${isReAsk ? 'you already asked this customer for a date and they replied with something else, so ask again in COMPLETELY DIFFERENT words, briefly acknowledging their message first. Do not repeat your earlier phrasing, and do not ask which property — that is already settled.' : 'the customer has chosen a property to view. Confirm their choice briefly and ask what date and time would suit them.'} One or two short sentences.

You may refer to the chosen property as: "${propertyLabel}". Do not state its price or any other detail.${historyBlock(history)}`;

    const user = 'Write the reply.';

    return callComposer(system, user, BOT_STRINGS.ask_datetime[lang]);
};

// ── composeBookingConfirmed ──
// The appointment row is already written. The factual recap (property +
// requested time) is appended by the caller — this is only the warm wrapper.
const composeBookingConfirmed = async ({ lang, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: their viewing request has just been registered. Confirm it warmly in ONE short sentence, and say the office will be in touch to confirm the visit. The property and requested time are printed directly beneath your line, so do NOT repeat them yourself.${historyBlock(history)}`;

    const user = 'Write the confirmation line.';

    return callComposer(system, user, BOT_STRINGS.booking_confirmed[lang]);
};

// ── composeBookingDeclined ──
const composeBookingDeclined = async ({ lang, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer decided not to book right now. Be gracious and low-pressure in ONE short sentence, and leave the door open if they want to look at something else. Do not be pushy and do not re-list properties.${historyBlock(history)}`;

    const user = 'Write the reply.';

    return callComposer(system, user, BOT_STRINGS.booking_declined[lang]);
};

// ── composeSelectionUnclear ──
// Genuinely couldn't tell which listing they meant.
const composeSelectionUnclear = async ({ lang, userMessage, listingCount, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: you showed ${listingCount} properties and asked which one they'd like to view, but their reply didn't identify one. Politely ask them to point at a specific one — by number is easiest. Keep it friendly and brief; do not make them feel at fault.

Do NOT quote prices or property details back at them, even if they appear earlier in the conversation — just ask which number.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.booking_selection_unclear[lang]);
};

// composeMediaResent
// They asked to see more of a specific listing ("share some photos of 1").
// The media itself is sent separately by the caller; this is just the line
// that goes with it.
const composeMediaResent = async ({ lang, propertyLabel, hasMedia, history, stillNeeded }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer asked to see more of one specific property${hasMedia ? ', and the photos/video are being sent to them right after your message' : ", but we do not have any photos or video on file for it"}.
${hasMedia
        ? 'Confirm warmly in ONE short sentence that the media is on its way, and invite them to say if they would like to arrange a viewing. Do not describe the photos — you have not seen them.'
        : "Tell them honestly in ONE short sentence that you don't have photos for it yet, and offer that the office can share more details or arrange a viewing. Do not apologise more than once."}

You may refer to the property as: "${propertyLabel}". Do NOT state its price or any other detail.${stillNeededLine(stillNeeded)}${historyBlock(history)}`;

    const user = 'Write the reply.';

    return callComposer(system, user, BOT_STRINGS[hasMedia ? 'media_resent' : 'media_unavailable'][lang]);
};

module.exports = {
    composeResultsIntro,
    composeMediaResent,
    composeListingAnswer,
    composeConfirmBooking,
    composeMidFlowAcknowledgement,
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
};
