// ── The Next-Best-Action engine ──
//
// After every inbound message, exactly one question matters: what is the single
// best thing to do next? This file answers it — and it answers it in CODE, not
// in a prompt.
//
// That is deliberate. The LLM is the language layer, not the application: it
// writes the words, this decides the move. Keeping the decision here means it
// is free, instant, deterministic, and — most importantly — exhaustively
// testable by smoke-bot, which is the only reason a booking flow that silently
// cancelled itself was ever caught in this project.
//
// STRUCTURE: an ordered list of rules, first match wins. Not nested ifs. That
// buys three things:
//   - the ordering IS the bot's goal hierarchy, readable top to bottom;
//   - a test can iterate every rule and assert each one is reachable;
//   - adding behaviour is inserting a row, not surgery on a conditional.
//
// PURITY: no DB, no network, no await, no Date.now(). Everything it needs
// arrives in `ctx`. That is what lets the whole decision space be covered in
// milliseconds instead of minutes.

const ACTIONS = {
    // Hand back to the existing booking state machine (handleViewingSelectionReply
    // / handleViewingDateTimeReply). NOT a decision about what to say — a
    // decision NOT to interfere. See the rule ordering note below.
    DELEGATE_BOOKING_FLOW: 'DELEGATE_BOOKING_FLOW',

    // Stop and get a person. Knowing when NOT to answer is a feature: price
    // negotiation, complaints and legal/financial questions are all places
    // where a confident wrong answer costs the agency far more than a pause.
    HANDOFF: 'HANDOFF',

    // Answer a question about how property works here. Sometimes the right
    // next action is simply to answer, not to steer toward a booking.
    ANSWER_QUESTION: 'ANSWER_QUESTION',

    SWITCH_LANGUAGE: 'SWITCH_LANGUAGE',
    CLOSE: 'CLOSE',
    ASK_WHAT_THEY_WANT: 'ASK_WHAT_THEY_WANT',
    ANSWER_OFF_TOPIC: 'ANSWER_OFF_TOPIC',
    GREET: 'GREET',

    // ── Qualifying-question gate ──
    // CITY and BUDGET are HARD requirements: the bot must never run a search
    // without both. Everything else (including neighbourhood) is a softer
    // extra asked in between. One question at a time, never two together, and
    // nothing is asked that the lead has already answered — so stating it all
    // in one message searches immediately.
    //
    // These are asked in list order below: city -> neighbourhood -> budget.
    ASK_CITY: 'ASK_CITY',
    ASK_NEIGHBOURHOOD: 'ASK_NEIGHBOURHOOD',
    ASK_BUDGET: 'ASK_BUDGET',

    SEARCH_AND_SHOW: 'SEARCH_AND_SHOW',
};

// ── The one list of actions allowed to end a booking ──
//
// Read this before adding an action. The worst bug this project has had, twice,
// was a booking-flow decision quietly clearing pending state: a lead asked
// "can you send photos?" while being asked for a date, that got bucketed as a
// refusal, and their viewing silently evaporated. Nothing surfaced it, because
// the reply still read fine.
//
// The invariant is: only an explicit refusal, or a deliberate move off the
// booking track, may clear pending state. It is enforced structurally — the
// first rule below hands ANY pending conversation straight to the booking
// handlers, which are the only code permitted to call clearPendingAction.
// smoke-bot asserts the resulting pending state on every scenario precisely
// because a lost booking is invisible if you only read what the bot said.
const ACTIONS_THAT_MAY_CLEAR_PENDING = [
    ACTIONS.DELEGATE_BOOKING_FLOW, // the booking handlers own that decision
    ACTIONS.SWITCH_LANGUAGE,       // handled without touching state; listed as an explicit exception
];

// ── The rules, in priority order. First match wins. ──
//
// This ordering is the goal hierarchy: protect an in-progress booking, honour
// an explicit request about the conversation itself, respond to social cues,
// and otherwise get on with finding them a property.
const RULES = [
    {
        name: 'protect_active_booking',
        // ALWAYS first. A lead mid-booking is answering a question we asked,
        // and the booking NLUs understand that context; general reasoning does
        // not and would happily route "1" to a fresh property search. The two
        // escapes that exist (a genuine new search, an explicit language
        // switch) are handled INSIDE those handlers, so they can decide
        // deliberately rather than having the decision taken from them here.
        when: (ctx) => Boolean(ctx.pendingAction),
        action: ACTIONS.DELEGATE_BOOKING_FLOW,
    },
    {
        name: 'wants_human',
        // Second only to protecting a booking. Deliberately ABOVE closing,
        // greeting and search: someone asking for a person, disputing a price
        // or raising a complaint must not have that softened into a cheerful
        // property suggestion. If they were mid-booking, rule #1 already won —
        // the booking handlers deal with it there.
        when: (ctx) => ctx.intent === 'wants_human',
        action: ACTIONS.HANDOFF,
    },
    {
        name: 'explicit_language_switch',
        // "in English please" on its own is a request about how we speak, not
        // a property search. Bundled with a search ("show me villas in
        // english") it falls through — the search below renders in the new
        // language anyway, so answering is better than just acknowledging.
        when: (ctx) => Boolean(ctx.languageSwitchRequest) && ctx.intent !== 'search',
        action: ACTIONS.SWITCH_LANGUAGE,
    },
    {
        name: 'general_question',
        // Above closing and greeting: a real question deserves an answer, not
        // a pleasantry. Below wants_human, because a legal or financial
        // question must reach a person rather than the knowledge base.
        when: (ctx) => ctx.intent === 'general_question',
        action: ACTIONS.ANSWER_QUESTION,
    },
    {
        name: 'closing',
        // "thanks" / "merci" / "ok bye". Must outrank greeting: thanking the
        // bot used to be read as a greeting and answered with a full welcome,
        // which was the most robotic thing it did.
        when: (ctx) => ctx.intent === 'closing',
        action: ACTIONS.CLOSE,
    },
    {
        name: 'booking_intent_with_nothing_shown',
        // They want to book, but we have shown them nothing to book. Asking
        // what they are after beats asking which of zero listings they meant.
        when: (ctx) => ctx.intent === 'booking_intent',
        action: ACTIONS.ASK_WHAT_THEY_WANT,
    },
    {
        name: 'off_topic',
        when: (ctx) => ctx.intent === 'off_topic',
        action: ACTIONS.ANSWER_OFF_TOPIC,
    },
    {
        name: 'greeting',
        when: (ctx) => ctx.intent === 'greeting',
        action: ACTIONS.GREET,
    },
    {
        name: 'ask_city',
        // HARD requirement #1. Deliberately depends on NOTHING but city being
        // absent.
        //
        // This rule previously did not exist, and `ask_budget` below required
        // `city && property_type` to be BOTH already known before it would
        // fire. That is why the gate never worked: the two reported failures
        // ("I want a villa to rent" — no city; "not villa" — type cleared) are
        // exactly the cases that fail that precondition, so the gate sat there
        // permanently unreachable while the bot searched anyway. A gate must
        // not be conditioned on the very field whose absence it exists to
        // catch.
        when: (ctx) => !ctx.profile?.city,
        action: ACTIONS.ASK_CITY,
    },
    {
        name: 'ask_neighbourhood',
        // The SOFT extra, asked between the two hard ones. Still requires city
        // and type, which is fine — it is not a gate, and `ask_city` above
        // plus `ask_budget` below already guarantee a search cannot happen
        // without the two fields that matter. If type is unknown this simply
        // doesn't fire and we go straight on to budget.
        when: (ctx) => Boolean(ctx.profile?.city) && Boolean(ctx.profile?.property_type)
            && !ctx.profile?.neighbourhood && !ctx.profile?.neighbourhood_no_preference,
        action: ACTIONS.ASK_NEIGHBOURHOOD,
    },
    {
        name: 'ask_budget',
        // HARD requirement #2. Like ask_city, depends only on budget being
        // absent — never on city or type being present.
        //
        // `budget_stretch_max` counts: it is a real stated ceiling and is what
        // profileToSearchFilters turns into price_ceiling, so a lead who gave
        // one has answered the budget question. `budget_no_preference` is the
        // explicit "any budget" opt-out — without it, a lead who genuinely
        // doesn't have a figure would be asked forever with no way out.
        //
        // NOTE: the profile column is `budget_max`. There is no
        // `profile.price_max` — that is the FILTER name that
        // profileToSearchFilters() maps this to. Reading `profile.price_max`
        // here would be undefined for every lead and the bot would never
        // search again.
        when: (ctx) => !ctx.profile?.budget_max && !ctx.profile?.budget_stretch_max
            && !ctx.profile?.budget_no_preference,
        action: ACTIONS.ASK_BUDGET,
    },
    {
        name: 'search',
        // The catch-all — but no longer an unconditional one. By the time
        // execution reaches here, city and budget are both known (or budget
        // was explicitly waived), because the three rules above cannot be
        // passed otherwise.
        //
        // This REVERSES the bot's original bias. It used to search on a single
        // detail — "a vague message ('anything cheap?') is still a real
        // request... showing something beats interrogating them". The client
        // has explicitly overridden that: collect city and budget first, every
        // time. `unclear` still lands here rather than re-greeting, it just
        // now gets a qualifying question instead of listings.
        when: () => true,
        action: ACTIONS.SEARCH_AND_SHOW,
    },
];

// ── nextBestAction(ctx) ──
// ctx: { pendingAction, intent, languageSwitchRequest, profile }
// Returns { action, rule } — the rule name comes back so logs and tests can
// say WHY, not just what.
const nextBestAction = (ctx = {}) => {
    for (const rule of RULES) {
        if (rule.when(ctx)) {
            return { action: rule.action, rule: rule.name };
        }
    }
    // Unreachable: the last rule matches everything. Kept so a future edit that
    // removes the catch-all fails loudly here instead of returning undefined
    // and producing a bot that silently says nothing.
    throw new Error('nextBestAction: no rule matched — the catch-all rule is missing');
};

module.exports = { ACTIONS, ACTIONS_THAT_MAY_CLEAR_PENDING, RULES, nextBestAction };
