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
- Plain text only. A single emoji is acceptable at most, and only in a greeting.
- When asking about location and you don't know it yet, ask for the CITY first (e.g. Lomé or Noèpé) — never ask for a specific neighbourhood before you know the city. Only ask about a neighbourhood as a follow-up once the city is known, and only if it would genuinely help.`;

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
// `relaxed` now carries the match-criterion keys emitted by
// utils/propertyMatcher (location / budget / bedrooms / type / transaction),
// not the old cascade's filter names. These MUST stay in step: an unrecognised
// key makes this return '' and the bot silently stops admitting that the top
// result isn't what was asked for — a dishonesty regression with no error.
const describeRelaxation = (relaxed, filters) => {
    if (!relaxed || relaxed.length === 0) return '';
    const parts = [];
    if (relaxed.includes('location')) {
        parts.push(filters.neighbourhood ? `the neighbourhood "${filters.neighbourhood}"` : `the area they asked for`);
    }
    if (relaxed.includes('bedrooms')) parts.push(`the number of bedrooms they asked for`);
    if (relaxed.includes('type')) parts.push(`the property type they asked for`);
    // Showing a buyer rental listings (or vice versa) is the mismatch most
    // likely to waste their time — say it plainly, not as "the type".
    if (relaxed.includes('transaction') && filters.transaction) {
        parts.push(filters.transaction === 'sale'
            ? 'being for sale (these are rentals)'
            : 'being for rent (these are for sale)');
    }
    if (relaxed.includes('budget')) parts.push(`their stated budget`);
    if (parts.length === 0) return '';
    return `IMPORTANT: the closest match is not an exact one — it does NOT match ${parts.join(' and ')}. Acknowledge this honestly and briefly in your opening line so the customer is not misled. Each listing below is already marked with what it does and does not match, so do NOT list those details yourself.`;
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
    // Used when they asked about ONE specific, already-named listing (see
    // composeListingAnswer). Ending with "which one would you like?" here
    // would ignore the property they just named and ask them to choose all
    // over again — ask about booking THAT one instead.
    if (stillNeeded === 'viewing_for_named') return '\n\nEnd by asking, in a FRESH wording, whether they would like to arrange a viewing for THIS property. Do NOT ask "which one" — they already told you which listing they mean.';
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

Your task: tell the customer nothing currently matches, then ask ONE specific, useful follow-up question that would help you find something (for example about their city, budget, or property type — pick whichever they did NOT already tell you). Do not apologise more than once.${historyBlock(history)}`;

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
        : 'They have contacted us before, so greet them back warmly like a returning customer ("Hello again!" / "Bonjour, ravi de vous revoir !") WITHOUT repeating the full introduction.'} Then invite them to say what they are looking for, mentioning naturally that they can tell you the city, the type of property, their budget, or the number of bedrooms — never as a rigid list or a form.${historyBlock(history)}`;

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

// ── composeObjection ──
// They pushed back on everything shown. §32: an objection is information, not
// a rejection — the useful reply narrows the gap rather than restating the
// pitch or asking them to repeat themselves.
//
// The price case is handled by re-searching instead (see the handler), so this
// covers the ones where we genuinely need to know more, plus the "I'll think
// about it" case where the correct move is to stop selling.
const OBJECTION_TASK = {
    location: 'They said the areas do not work for them. Ask which area or which part of town would suit them better — do not defend the ones you showed.',
    size: 'They said the properties are not the right size. Ask how many bedrooms they actually need.',
    thinking_about_it: 'They want time to think. Say warmly that that is completely fine, and that you will be here when they are ready. Do NOT push, do NOT ask a qualifying question, and do NOT offer a viewing. Offer at most to keep looking if anything else comes up.',
};

const composeObjection = async ({ lang, userMessage, objectionType, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer has pushed back on everything you showed them. ${OBJECTION_TASK[objectionType] || 'Acknowledge their reaction and ask ONE question that would help you find something closer to what they want.'}

Take it graciously — they are telling you something useful, not complaining. Do NOT argue, do NOT re-describe the properties, do NOT apologise more than once, and do NOT repeat a question you have already asked. One or two short sentences.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.objection_ack[lang]);
};

// ── composeKnowledgeAnswer ──
// Answers a general question about how property works in Togo, using ONLY the
// curated facts passed in (utils/knowledge.js).
//
// This is the strictest prompt in the file, because the failure mode is the
// worst: fluently inventing a deposit norm or a legal requirement, about money
// and law, in a market the model knows little about. No matching facts means
// say so — the fallback exists precisely so "I don't know" is always available.
//
// Per the doc's §30: answering IS the goal here. It must not pivot to selling.
const composeKnowledgeAnswer = async ({ lang, userMessage, facts, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: answer the customer's question about how property works in Togo, using ONLY the verified facts below. Put them in your own words, briefly and warmly.

VERIFIED FACTS — this is everything you know on the subject:
${facts}

Absolute rules:
- Answer ONLY from the facts above. Do NOT add detail, figures, timeframes, legal specifics or local custom from your own knowledge, however confident you feel — being wrong about money or law here would genuinely harm this customer.
- If the facts above do not actually answer what they asked, say plainly that you'd rather have a colleague confirm it, and give the office number +228 91062626.
- Do NOT quote a price, a commission, a deposit amount, or any number that is not written above.
- Answer the question and stop. Do NOT pitch a property or push a viewing — they asked something reasonable and deserve an answer, not a sales turn. A single light offer to help further is fine only if it fits naturally.
- 2-4 short sentences.${historyBlock(history)}`;

    const user = `The customer asked: "${userMessage}"

Write the answer.`;

    return callComposer(system, user, BOT_STRINGS.knowledge_unknown[lang]);
};

// ── composeComparison ──
// The one line UNDER a comparison table that says which way to lean. This is
// the difference between dumping data and actually helping.
//
// The table itself is rendered deterministically by formatComparison; this
// writes only the judgement — and only in terms of priorities the customer has
// actually expressed. "If staying near work matters most, the first is closer"
// is useful; inventing a priority they never mentioned is not.
const composeComparison = async ({ lang, userMessage, summary, statedPriorities, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer asked you to compare properties. A side-by-side breakdown is printed directly BELOW your line, so do NOT list the prices, areas or bedroom counts yourself — they will see them.

Write ONE short sentence pointing them toward whichever suits them, framed as a trade-off ("if X matters more to you, then the first; if Y, the second").

${statedPriorities
        ? `What this customer has actually told you matters to them: ${statedPriorities}. Base your steer on that.`
        : `They have NOT told you what matters most to them. So do not guess a priority — instead, name the single clearest difference between the options and ask which of those two things matters more.`}

These are the ONLY facts you may use. Every detail you mention must appear here, attributed to the same numbered property it is listed under — do not carry details across from one to the other, and do not use anything from earlier in the conversation:
${summary}

Do not say one is "better". Do not recommend booking. Do not mention any feature not listed above.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the one-line steer.`;

    return callComposer(system, user, BOT_STRINGS.comparison_intro[lang]);
};

// ── composeAskRejectionReason ──
// They turned one down without saying why. "Okay" is a wasted turn; asking
// WHAT was wrong is what turns a rejection into a better next search — and
// offering concrete options ("the price, the area, or the size?") is far easier
// to answer than an open "why not?".
const composeAskRejectionReason = async ({ lang, userMessage, propertyLabel, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: the customer has just said they don't like one of the properties you showed. Acknowledge that easily and without any pushback, then ask what specifically didn't work — offering them the likely options to choose from (the price, the area, or the size) rather than an open-ended "why?".

Do NOT try to talk them back into it. Do NOT re-describe the property. Do NOT apologise more than once. One or two short sentences.${propertyLabel ? `\n\nYou may refer to it as: "${propertyLabel}". Do NOT state its price or any other detail.` : ''}${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the reply.`;

    return callComposer(system, user, BOT_STRINGS.ask_rejection_reason[lang]);
};

// ── composeHandoff ──
// The bot stepping back. The calling code has genuinely flagged this lead for a
// human in the dashboard, so "I'm passing this on" is a true statement — which
// is the only reason BASE_PERSONA's no-claimed-actions rule permits saying it.
// It must still not invent a timeframe, quote a price, or hint at what the
// agency might agree to.
const REASON_CONTEXT = {
    asked_for_agent: 'They asked to speak to a person.',
    negotiation: 'They want to negotiate the price or terms — only the agency can discuss that.',
    complaint: 'They are unhappy about something. Acknowledge it warmly and without being defensive; do not argue or explain it away.',
    legal_or_financial: 'They asked a legal, contractual or financial question that must not be answered speculatively.',
    repeated_misunderstanding: 'You have failed to understand them several times running. Do not ask them to rephrase again — apologise once, briefly, and hand over.',
};

const composeHandoff = async ({ lang, userMessage, reason, history }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: this needs a human colleague, not you. ${REASON_CONTEXT[reason] || 'They need a person rather than an assistant.'}

Tell them warmly that you are passing this to an EXCELIA advisor who will follow up, and that they can also call the office on +228 91062626. This IS true — they have been flagged for a colleague — so you may say it.

Do NOT attempt to answer the question yourself. Do NOT quote or imply any price, discount, or what the agency might agree to. Do NOT promise when someone will reply. Two short sentences at most.${historyBlock(history)}`;

    const user = `The customer wrote: "${userMessage}"

Write the handover message.`;

    return callComposer(system, user, BOT_STRINGS.handoff[lang]);
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
// `needsName`: true only on the FIRST ask, and only when nothing already
// supplied a name (neither WhatsApp's own profile name nor an earlier
// self-introduction — see getOrCreateLead / updateLeadNameIfMissing). Never
// set on a re-ask: nagging for a name a second time, on top of a second date
// request, is exactly the kind of friction the doc warns against, and one
// genuine attempt is enough — a booking must never be blocked on it.
const composeAskDatetime = async ({ lang, propertyLabel, history, isReAsk, needsName }) => {
    const system = `${BASE_PERSONA}

Write in ${LANGUAGE_NAME[lang]}. Reply in ${LANGUAGE_NAME[lang]} ONLY.

Your task: ${isReAsk ? `you already asked this customer for a date and they replied with something else, so ask again in COMPLETELY DIFFERENT words, briefly acknowledging their message first. Do not repeat your earlier phrasing, and do not ask which property — that is already settled. Even if the conversation above shows you also asked for their name and they have not given it, do NOT ask for it again here — one attempt at that was enough, and repeating it would nag them right when they're already struggling to reply. Ask ONLY about the date/time.` : 'the customer has chosen a property to view. Confirm their choice briefly and ask what date and time would suit them.'}${needsName ? ' Also ask for their name in the SAME message, naturally — e.g. so the office knows who to expect for the visit. Do not turn this into two separate questions; weave it into one natural sentence.' : ''} One or two short sentences${needsName ? ' (may run to three to fit the name in naturally)' : ''}.

You may refer to the chosen property as: "${propertyLabel}". Do not state its price or any other detail.${historyBlock(history)}`;

    const user = 'Write the reply.';

    return callComposer(system, user, needsName ? BOT_STRINGS.ask_datetime_and_name[lang] : BOT_STRINGS.ask_datetime[lang]);
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
    composeHandoff,
    composeAskRejectionReason,
    composeComparison,
    composeKnowledgeAnswer,
    composeObjection,
    composeUnsupportedMedia,
    composeLanguageSwitch,
    composeClosing,
    composeBookingPrompt,
    composeAskDatetime,
    composeBookingConfirmed,
    composeBookingDeclined,
    composeSelectionUnclear,
};
