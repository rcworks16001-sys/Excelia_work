require('dotenv').config();
const pool = require('../src/db/index');
const wh = require('../src/controllers/webhookController');
const { getLeadState } = require('../src/controllers/leadController');
const { getProfile } = require('../src/controllers/leadProfileController');
const { BOT_STRINGS } = require('../src/utils/language');
const { RULES, nextBestAction, ACTIONS } = require('../src/utils/nextBestAction');

// ── EXCELIA bot scenario suite ──
// Run manually:  npm run smoke-bot
//
// WHY THIS EXISTS: an earlier verification pass re-implemented the handler
// logic inline instead of calling the real functions. That copy happened to
// have `history` in scope, so it passed — while the real
// handleViewingSelectionReply threw "ReferenceError: history is not defined"
// on EVERY reply after a listing set, and leads just saw "Sorry, something
// went wrong." Testing a reimplementation proves nothing about real code.
//
// So this drives the ACTUAL production entry point — processInboundMessage(),
// which is everything handleMessage does except the WhatsApp send. It catches
// undefined variables, changed return shapes, routing drift, and — most
// importantly — silently destroyed booking state, which is invisible to
// `node -c` and to eyeballing replies. Every scenario asserts the resulting
// pending state, not just text.
//
// No WhatsApp messages are sent. Each scenario uses its own disposable lead,
// deleted before and after, so the DB is left exactly as found.

let failures = 0;

const check = (label, ok, detail) => {
    console.log(`      ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) {
        failures += 1;
        if (detail) console.log(`            ${String(detail).slice(0, 160)}`);
    }
};

const cleanup = async (phone) => {
    const s = await getLeadState(phone);
    if (s) await pool.query('DELETE FROM appointments WHERE lead_id = $1', [s.id]);
    await pool.query('DELETE FROM leads WHERE phone = $1', [phone]);
};

// Drives the REAL production router. processInboundMessage() is the whole bot
// minus transport, so this exercises the exact code path a live WhatsApp
// message takes — routing, language precedence, welcome prefix and all — and
// sends nothing.
//
// This used to re-implement that routing inline. It passed while production
// drifted away from it (a stale justBooked expression, greeting and
// booking_intent collapsed into one branch, no welcome_prefix) — the same
// class of bug described in the header above, one layer up. Never reintroduce
// a copy of the router here: if something is hard to drive through
// processInboundMessage, that is a signal to improve its seams, not to fork it.
const send = async (phone, text) => {
    const before = await getLeadState(phone);
    const pendingBefore = before?.pendingAction || null;

    const { replyText, mediaListings, lang } = await wh.processInboundMessage({
        phone, text, contactName: 'Smoke Test', messageType: 'text',
    });

    const after = await getLeadState(phone);
    // Routing is no longer decided here, so report the observable state
    // transition instead of an internal branch name.
    const route = `${pendingBefore || 'idle'} -> ${after.pendingAction || 'idle'}`;
    console.log(`\n      > ${text}`);
    console.log(`        [${lang} | ${route}${mediaListings ? ` | media x${mediaListings.length}` : ''}]`);
    console.log(`      < ${replyText.split('\n')[0].slice(0, 130)}`);
    return {
        reply: replyText,
        media: mediaListings,
        lang,
        route,
        pendingAction: after.pendingAction,
        leadId: after.id,
    };
};

const apptCount = async (phone) => {
    const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM appointments WHERE lead_id = (SELECT id FROM leads WHERE phone = $1)', [phone]);
    return rows[0].n;
};

// ── Scenario selection ──
//   npm run smoke-bot              every scenario (the pre-commit gate)
//   npm run smoke-bot -- 30-34     a range
//   npm run smoke-bot -- 3,7,12    specific ones
//
// A full run is roughly 200 Claude calls against the project's own API budget.
// While iterating on one feature that is mostly waste, so this makes the tight
// loop cheap. It is NOT a substitute for the full run: ALWAYS run the whole
// suite before committing, because the failures that matter most here have
// historically been in code the change did not appear to touch.
const parseSelection = (arg) => {
    if (!arg) return null;
    const wanted = new Set();
    for (const part of arg.split(',')) {
        const range = part.trim().match(/^(\d+)-(\d+)$/);
        if (range) {
            for (let i = Number(range[1]); i <= Number(range[2]); i += 1) wanted.add(i);
        } else if (/^\d+$/.test(part.trim())) {
            wanted.add(Number(part.trim()));
        }
    }
    return wanted.size ? wanted : null;
};
const selection = parseSelection(process.argv[2]);
let skipped = 0;

// Each scenario gets its own phone number so they can't contaminate each other.
let seq = 0;
const scenario = async (title, fn) => {
    // seq increments even when skipped, so scenario numbers stay stable
    // whichever subset is run — otherwise "run scenario 30" would mean a
    // different test depending on the filter.
    seq += 1;
    if (selection && !selection.has(seq)) { skipped += 1; return; }

    const phone = `9990001${String(seq).padStart(5, '0')}`;
    console.log(`\n${'-'.repeat(72)}\n${seq}. ${title}`);
    await cleanup(phone);
    try {
        await fn(phone);
    } finally {
        await cleanup(phone);
    }
};

const run = async () => {
    console.log('\n=== EXCELIA bot scenario suite (no WhatsApp messages sent) ===');

    await scenario('Happy path: greet -> search -> select -> date -> confirm -> thanks', async (p) => {
        await send(p, 'Hello');
        const r = await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        check('search returned listings', /F CFA/.test(r.reply));
        const s = await send(p, '1');
        check('asked for a date', s.pendingAction === 'awaiting_viewing_datetime');
        const d = await send(p, 'tomorrow 11am');
        check('booking completed', !d.pendingAction);
        check('appointment row written', (await apptCount(p)) === 1);
        const t = await send(p, 'Thank you');
        check('thanks did not trigger a welcome', !/welcome to excelia/i.test(t.reply));
    });

    await scenario('THE REPORTED BUG: photos requested while bot awaits a date', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        await send(p, '1');
        const r = await send(p, 'Can you share some photos ?');
        check('sent media', Array.isArray(r.media) && r.media.length === 1, `media=${r.media && r.media.length}`);
        check('BOOKING SURVIVED', r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
        check('did not claim a booking exists', !/(confirmed|registered|booked)\b/i.test(r.reply), r.reply);
        const d = await send(p, 'friday afternoon');
        check('can still complete the booking', (await apptCount(p)) === 1);
    });

    await scenario('Question while bot awaits a date', async (p) => {
        await send(p, 'I want a villa in Lome, any area is fine, budget 500000');
        await send(p, '1');
        const r = await send(p, 'what is the price again?');
        check('BOOKING SURVIVED', r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
        check('answered with real listing facts', /F CFA/.test(r.reply));
    });

    await scenario('"Hello" while choosing a listing', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        const r = await send(p, 'Hello');
        check('flow preserved', r.pendingAction === 'awaiting_viewing_selection');
        check('did not re-welcome', !/welcome to excelia|bienvenue chez excelia/i.test(r.reply), r.reply);
    });

    await scenario('"thanks" while choosing a listing', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        const r = await send(p, 'thanks');
        check('did not re-welcome', !/welcome to excelia/i.test(r.reply), r.reply);
    });

    await scenario('Explicit decline DOES clear the flow', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        const r = await send(p, 'no thanks, not interested');
        check('flow cleared', !r.pendingAction, `pending=${r.pendingAction}`);
        check('no appointment created', (await apptCount(p)) === 0);
    });

    await scenario('Photos requested mid-selection without saying which', async (p) => {
        await send(p, 'I want a villa in Lome, any area is fine, budget 500000');
        const r = await send(p, 'can you send photos?');
        check('flow preserved', r.pendingAction === 'awaiting_viewing_selection');
    });

    await scenario('Refine search after results (filters carry forward)', async (p) => {
        await send(p, 'I want a villa in Lome, budget 500000, any area is fine');
        const r = await send(p, 'actually under 400000');
        check('re-searched instead of trapping in booking', /F CFA/.test(r.reply), r.reply);
    });

    await scenario('Language switch mid-booking', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        await send(p, '1');
        const r = await send(p, 'en francais svp');
        check('switched to French', r.lang === 'fr');
        check('BOOKING SURVIVED', r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
    });

    await scenario('Off-topic message', async (p) => {
        const r = await send(p, 'what is the weather today');
        check('redirected without listings', !/F CFA/.test(r.reply));
    });

    await scenario('Vague query is QUALIFIED, not answered with listings', async (p) => {
        // INVERTED deliberately. This used to assert the opposite ("returned
        // listings instead of re-greeting") — showing something on a single
        // vague detail was the documented design. The client has overridden
        // that: city and budget are collected before anything is shown.
        // It must still not re-greet — a question gets a question, not a
        // welcome.
        const r = await send(p, 'Do you have anything cheap?');
        check('showed no listings', r.media === null, `media=${JSON.stringify(r.media)}`);
        check('asked which city', /city|town|ville|Lom/i.test(r.reply), r.reply);
        check('did not re-greet instead of asking',
            !/welcome to excelia|bienvenue chez excelia/i.test(r.reply.replace(BOT_STRINGS.welcome_prefix.en, '')), r.reply);
    });

    await scenario('Impossible query degrades gracefully', async (p) => {
        const r = await send(p, 'I need a 9 bedroom castle for 5000 francs');
        check('did not error out', !r.reply.includes(BOT_STRINGS.error_fallback.en));
    });

    await scenario('French happy path', async (p) => {
        await send(p, 'bonjour je cherche un appartement a Lome, peu importe le quartier, budget 200000');
        const s = await send(p, '1');
        check('asked for a date in French', s.pendingAction === 'awaiting_viewing_datetime');
        check('stayed in French', s.lang === 'fr');
        const d = await send(p, 'demain matin');
        check('booking completed', (await apptCount(p)) === 1);
    });

    await scenario('Booking asked with nothing shown must not fake a confirmation', async (p) => {
        await send(p, 'hello');
        const r = await send(p, 'I want to book a viewing please');
        check('no appointment exists', (await apptCount(p)) === 0);
        check('did not claim a booking', !/(is )?(confirmed|booked|registered)\b|let the team know/i.test(r.reply), r.reply);
    });

    await scenario('REPORTED: liking a property must NOT auto-book it', async (p) => {
        await send(p, 'I want a villa in Lome, any area is fine, budget 500000');
        const r = await send(p, 'Ok, 1 one I liked');
        check('did NOT jump straight to asking for a date',
            r.pendingAction !== 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
        check('asked whether they want a viewing', /\?/.test(r.reply), r.reply);
        check('did not ask for a date yet',
            !/what date|which date|quelle date|date and time/i.test(r.reply), r.reply);
        const y = await send(p, 'yes please');
        check('confirming then moves to the date step',
            y.pendingAction === 'awaiting_viewing_datetime', `pending=${y.pendingAction}`);
        const d = await send(p, 'saturday morning');
        check('booking completes', (await apptCount(p)) === 1);
    });

    await scenario('REPORTED: a returning customer saying Hi still gets greeted', async (p) => {
        await send(p, 'hello');
        await send(p, 'I want a villa in Lome, any area is fine, budget 500000');
        await send(p, 'no thanks');
        const r = await send(p, 'Hi');
        check('greeted back rather than only asking a question',
            /\b(hello|hi|hey|welcome|bonjour|salut|ravi)\b/i.test(r.reply), r.reply);
    });

    await scenario('A bare number after the booking prompt still books directly', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        const r = await send(p, '1');
        check('treated as a real choice, asked for a date',
            r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
    });

    await scenario('MEMORY: never asks the same question twice', async (p) => {
        await send(p, 'I am looking for a 1bhk in Lome, any area is fine, budget 100000');
        const a = await send(p, '1');                          // first date ask
        const b = await send(p, 'Can you share some photos ?'); // interruption 1
        const c = await send(p, 'where is it located');         // interruption 2
        const first = a.reply.trim().toLowerCase();
        const second = b.reply.trim().toLowerCase();
        const third = c.reply.trim().toLowerCase();
        check('2nd date-ask is not a verbatim repeat of the 1st', first !== second);
        check('3rd date-ask is not a verbatim repeat of either', third !== first && third !== second);
        check('flow still alive after two interruptions', c.pendingAction === 'awaiting_viewing_datetime');
    });

    // ── Scenarios 19-21: paths the old harness structurally could not reach ──
    // It re-implemented the router, and its copy had no welcome_prefix, no
    // isGreetingReply and no media branch — so these production behaviours
    // were completely untested until processInboundMessage was extracted.

    await scenario('NEW LEAD: first non-greeting message still gets the welcome prefix', async (p) => {
        const r = await send(p, 'I want a villa in Lome, any area is fine, budget 500000');
        check('welcomed on first contact', r.reply.includes(BOT_STRINGS.welcome_prefix.en), r.reply);
        check('and still answered immediately', /F CFA/.test(r.reply));
        const second = await send(p, 'what about an apartment');
        check('not welcomed twice', !second.reply.includes(BOT_STRINGS.welcome_prefix.en), second.reply);
    });

    await scenario('NEW LEAD: a greeting is not double-welcomed', async (p) => {
        const r = await send(p, 'Hello');
        // composeGreeting already welcomes; prefixing would say it twice.
        const occurrences = r.reply.split(BOT_STRINGS.welcome_prefix.en).length - 1;
        check('welcome prefix not stacked onto a greeting', occurrences === 0, r.reply);
    });

    await scenario('Non-text message replies without destroying language or state', async (p) => {
        await send(p, 'I am looking for a villa in Lome please, budget 400000, any area is fine');
        const r = await wh.processInboundMessage({
            phone: p, text: null, contactName: 'Smoke Test', messageType: 'image',
        });
        const after = await getLeadState(p);
        check('replied to the image', typeof r.replyText === 'string' && r.replyText.length > 0);
        check('did not flip an English lead to French', after.language === 'en', `language=${after.language}`);
        check('did not destroy pending booking state',
            after.pendingAction === 'awaiting_viewing_selection', `pending=${after.pendingAction}`);
    });

    // ── Scenarios 22-25: the lead profile and the decision engine ──

    await scenario('PROFILE: a requirement built over several turns is stored, not re-derived', async (p) => {
        await send(p, 'I am looking for a villa in Lome');
        await send(p, 'under 400000');
        const prof = await getProfile((await getLeadState(p)).id);
        check('profile row written', Boolean(prof));
        check('type remembered from turn 1', prof.property_type === 'villa', `type=${prof && prof.property_type}`);
        check('city remembered from turn 1', prof.city === 'Lomé', `city=${prof && prof.city}`);
        check('budget captured on turn 2', prof.budget_max === 400000, `budget=${prof && prof.budget_max}`);
    });

    await scenario('PROFILE: an explicit retraction clears the field (the ratchet bug)', async (p) => {
        await send(p, 'I want an apartment in Lome under 100000');
        const before = await getProfile((await getLeadState(p)).id);
        check('budget was set first', before.budget_max === 100000, `budget=${before && before.budget_max}`);

        await send(p, 'actually forget the budget, show me anything');
        const after = await getProfile((await getLeadState(p)).id);
        // The point: "forget X" must NULL it. If nulls were merely ignored the
        // old budget would persist forever and quietly exclude what they just
        // asked to see.
        check('budget actually cleared', after.budget_max === null, `budget=${after && after.budget_max}`);
        check('unrelated fields survived the retraction', after.city === 'Lomé', `city=${after && after.city}`);
    });

    await scenario('Stale pending booking state expires instead of trapping the lead', async (p) => {
        await send(p, 'I want a villa in Lome, any area is fine, budget 500000');
        const mid = await getLeadState(p);
        check('is awaiting a selection', mid.pendingAction === 'awaiting_viewing_selection');

        // Simulate the lead going quiet for two days.
        await pool.query("UPDATE leads SET pending_set_at = now() - interval '48 hours' WHERE phone = $1", [p]);
        const stale = await getLeadState(p);
        check('expired state reads as absent', stale.pendingAction === null, `pending=${stale.pendingAction}`);
        check('expiry is reported', stale.pendingExpired === true);

        // Their next message must be treated as a fresh start, NOT parsed as a
        // choice between listings they saw two days ago.
        const r = await send(p, 'hello');
        check('greeted rather than re-asked which property',
            !/which|lequel|numéro|number/i.test(r.reply), r.reply);
    });

    await scenario('NBA: every rule is reachable and booking always wins', async () => {
        // Pure and synchronous — no DB, no Claude, so the whole decision space
        // runs instantly. A rule that can never fire is dead code pretending
        // to be behaviour.
        const hit = new Set();
        const cases = [
            { pendingAction: 'awaiting_viewing_datetime', intent: 'greeting' },
            { pendingAction: null, intent: 'wants_human' },
            { pendingAction: null, intent: 'general_question' },
            { pendingAction: null, intent: 'greeting', languageSwitchRequest: 'en' },
            { pendingAction: null, intent: 'closing' },
            { pendingAction: null, intent: 'booking_intent' },
            { pendingAction: null, intent: 'off_topic' },
            { pendingAction: null, intent: 'greeting' },
            // A fully-qualified profile is now required to reach 'search'.
            { pendingAction: null, intent: 'search', profile: { city: 'Lomé', neighbourhood_no_preference: true, budget_max: 400000 } },
            { pendingAction: null, intent: 'unclear', profile: { city: 'Lomé', neighbourhood_no_preference: true, budget_max: 400000 } },
            // Qualifying-question gate, in the order it asks.
            { pendingAction: null, intent: 'search', profile: {} },
            { pendingAction: null, intent: 'search', profile: { city: 'Lomé', property_type: 'villa' } },
            { pendingAction: null, intent: 'search', profile: { city: 'Lomé', property_type: 'villa', neighbourhood: 'Bè' } },
        ];
        for (const c of cases) hit.add(nextBestAction(c).rule);
        const unreachable = RULES.map((r) => r.name).filter((n) => !hit.has(n));
        check('no unreachable rules', unreachable.length === 0, `unreachable: ${unreachable.join(', ')}`);

        // The invariant that has broken this project twice: nothing outranks an
        // active booking. Not a greeting, not a language switch, not a search.
        const intents = ['greeting', 'closing', 'off_topic', 'search', 'booking_intent', 'unclear', 'wants_human', 'general_question'];
        const leaks = intents.filter((intent) => nextBestAction({
            pendingAction: 'awaiting_viewing_datetime', intent, languageSwitchRequest: 'en',
        }).action !== ACTIONS.DELEGATE_BOOKING_FLOW);
        check('an active booking outranks every other rule', leaks.length === 0, `leaked: ${leaks.join(', ')}`);

        // 'unclear' must still not re-greet — but it now gets a qualifying
        // question rather than listings.
        const nba = (profile, intent = 'search') => nextBestAction({ pendingAction: null, intent, profile }).action;
        check('unclear is qualified, not re-greeted',
            nba({}, 'unclear') === ACTIONS.ASK_CITY, nba({}, 'unclear'));

        // ── THE HARD GATE. These two cases are the exact reported bugs, and
        // the two assertions that stood here before asserted the OPPOSITE
        // ("missing city alone never triggers the gate" -> SEARCH_AND_SHOW).
        // The old gate required city AND property_type to be known before it
        // would fire, which made it unreachable in precisely the situations it
        // existed for. Never reintroduce a precondition on the field a gate is
        // meant to catch.
        check('BUG 1: type but no city -> asks CITY, never searches',
            nba({ property_type: 'villa', transaction: 'rent' }) === ACTIONS.ASK_CITY,
            nba({ property_type: 'villa', transaction: 'rent' }));
        check('BUG 2: city but no type and no budget -> asks BUDGET, never searches',
            nba({ city: 'Lomé', neighbourhood_no_preference: true }) === ACTIONS.ASK_BUDGET,
            nba({ city: 'Lomé', neighbourhood_no_preference: true }));
        check('nothing known at all -> asks CITY', nba({}) === ACTIONS.ASK_CITY, nba({}));
        check('city known, budget missing -> asks (never searches)',
            nba({ city: 'Lomé' }) !== ACTIONS.SEARCH_AND_SHOW, nba({ city: 'Lomé' }));

        // Ask order: city -> neighbourhood -> budget.
        check('city+type, no neighbourhood -> asks neighbourhood',
            nba({ city: 'Lomé', property_type: 'villa' }) === ACTIONS.ASK_NEIGHBOURHOOD);
        check('neighbourhood known -> asks budget next, not neighbourhood again',
            nba({ city: 'Lomé', property_type: 'villa', neighbourhood: 'Bè' }) === ACTIONS.ASK_BUDGET);
        check('explicit "no preference" satisfies neighbourhood, moves to budget',
            nba({ city: 'Lomé', property_type: 'villa', neighbourhood_no_preference: true }) === ACTIONS.ASK_BUDGET);

        // Everything answered -> search, asking nothing twice.
        check('all known -> searches',
            nba({ city: 'Lomé', property_type: 'villa', neighbourhood: 'Bè', budget_max: 400000 }) === ACTIONS.SEARCH_AND_SHOW);
        check('explicit no-preference on both -> searches',
            nba({ city: 'Lomé', property_type: 'villa', neighbourhood_no_preference: true, budget_no_preference: true }) === ACTIONS.SEARCH_AND_SHOW);
        check('a stated stretch ceiling counts as a budget',
            nba({ city: 'Lomé', neighbourhood_no_preference: true, budget_stretch_max: 90000 }) === ACTIONS.SEARCH_AND_SHOW);

        // The naming trap: the profile column is budget_max. If the gate were
        // written against profile.price_max it would be undefined for every
        // lead and the bot would never search again.
        check('gate reads budget_max, not the non-existent price_max',
            nba({ city: 'Lomé', neighbourhood_no_preference: true, price_max: 400000 }) === ACTIONS.ASK_BUDGET);
    });

    // ── Scenarios 26-29: scoring, escalation and notifications ──

    await scenario('HANDOFF: price negotiation goes to a human, not to the bot', async (p) => {
        await send(p, 'I want a villa in Lome, budget 500000, any area is fine');
        const r = await send(p, 'can you lower the price? is it negotiable?');
        const lead = await getLeadState(p);
        const prof = await getProfile(lead.id);

        check('flagged for a human', prof.needs_human === true, `needs_human=${prof.needs_human}`);
        check('reason recorded', Boolean(prof.handoff_reason), `reason=${prof.handoff_reason}`);
        // The whole point: it must not improvise a discount or imply one.
        check('did not negotiate or quote a discount',
            !/\b(discount|reduce|lower it|remise|réduction|can offer)\b/i.test(r.reply), r.reply);
        check('notification raised for the agency',
            (await pool.query("SELECT 1 FROM notifications WHERE lead_id = $1 AND type = 'needs_human'", [lead.id])).rows.length === 1);
        // The invariant: escalating is not the same as giving up on the
        // viewing. Only an explicit refusal may end a booking flow.
        check('BOOKING SURVIVED the escalation',
            r.pendingAction === 'awaiting_viewing_selection', `pending=${r.pendingAction}`);
    });

    await scenario('HANDOFF: asking to speak to a person is honoured', async (p) => {
        const r = await send(p, 'I would like to speak to a real agent please');
        const lead = await getLeadState(p);
        const prof = await getProfile(lead.id);
        check('flagged for a human', prof.needs_human === true, `needs_human=${prof.needs_human}`);
        check('did not just show listings instead', !/F CFA/.test(r.reply), r.reply);
    });

    await scenario('SCORING: engagement raises the score and advances the pipeline', async (p) => {
        await send(p, 'I want to rent a villa in Lome, any area is fine, budget 400000, I need it this month');
        const lead = await getLeadState(p);
        const prof = await getProfile(lead.id);
        check('score computed', prof.lead_score > 0, `score=${prof.lead_score}`);
        check('specific requirement scores above cold', prof.lead_temperature !== 'cold', `temp=${prof.lead_temperature}`);

        const status = (await pool.query('SELECT status FROM leads WHERE id = $1', [lead.id])).rows[0].status;
        check('bot advanced the pipeline past "new"', status !== 'new', `status=${status}`);
    });

    await scenario('SCORING: the bot never overrides a human\'s "lost" verdict', async (p) => {
        await send(p, 'I want a villa in Lome with 4 bedrooms, any area is fine, budget 400000, moving this month');
        const lead = await getLeadState(p);

        // An admin decides this lead is dead.
        await pool.query("UPDATE leads SET status = 'lost' WHERE id = $1", [lead.id]);

        // The lead keeps talking. Their status must NOT come back to life —
        // 'lost' is a human judgement the bot cannot observe or overrule.
        await send(p, 'actually I am ready to book a viewing this week');
        const status = (await pool.query('SELECT status FROM leads WHERE id = $1', [lead.id])).rows[0].status;
        check('"lost" is absorbing', status === 'lost', `status=${status}`);
    });

    // ── Scenarios 30-33: matching, ranking and the rejection loop ──

    await scenario('RANKING: the best match leads, not the cheapest listing', async (p) => {
        // The old ORDER BY price ASC showed a 35 000 single room first to
        // someone asking for a 4-bedroom villa, every single time.
        const r = await send(p, 'I want to rent a 4 bedroom villa in Lome, budget 400000, any area is fine');
        const first = r.reply.split('\n\n').find((b) => /^1\./.test(b.trim())) || '';
        check('top result is a villa, not the cheapest room',
            /villa/i.test(first) && !/single room|chambre/i.test(first), first.slice(0, 120));
        check('shows why it matches', /✓/.test(r.reply), r.reply.slice(0, 200));
    });

    await scenario('MATCH REASONS: a near miss is marked, never silently substituted', async (p) => {
        // Nothing in Bè has 3 bedrooms under 200 000, so whatever comes back
        // MUST carry an explicit ✗ rather than being passed off as a match.
        const r = await send(p, 'I need a 3 bedroom in Be, Lome, to rent, maximum 200000');
        check('marks what does not match', /✗/.test(r.reply), r.reply.slice(0, 300));
        // BASE_PERSONA forbids implying a criterion matched that was never
        // stated. They gave no property type, so no type line should appear.
        check('does not invent criteria they never gave',
            !/✓\s*(Villa|Apartment|Land|Mini-villa)/.test(r.reply), r.reply.slice(0, 300));
    });

    await scenario('REASONS: nothing is claimed for a criterion never stated', async (p) => {
        // The safety property is unchanged — the bot must never print a ✓/✗ for
        // something the customer did not ask for. Only the SETUP had to change:
        // city and budget are now mandatory before any search, so "✓ Lomé" and
        // "✓ Within your budget" are legitimately expected here. What must NOT
        // appear is a claim about property TYPE or BEDROOMS, neither of which
        // was stated. (The old version asserted zero ✓/✗ of any kind, which is
        // unreachable now that a search requires two stated criteria.)
        const r = await send(p, 'do you have anything cheap in Lome, budget 100000');
        check('returned listings', Array.isArray(r.media) && r.media.length > 0, r.reply.slice(0, 200));
        check('no fabricated TYPE claim',
            !/[✓✗]\s*(Villa|Apartment|Single room|Land|Mini-villa|Furnished apartment)/.test(r.reply),
            r.reply.slice(0, 300));
        check('no fabricated BEDROOM claim',
            !/[✓✗][^\n]*bedroom/i.test(r.reply), r.reply.slice(0, 300));
    });

    await scenario('REJECTION LOOP: "I don\'t like the first one" asks why, then re-ranks', async (p) => {
        await send(p, 'I want to rent a villa in Lome, budget 500000, any area is fine');
        const asked = await send(p, "I don't like the first one");
        check('asked what was wrong rather than just accepting it',
            /price|area|size|prix|quartier|taille/i.test(asked.reply), asked.reply);
        // Turning one listing down is NOT declining the whole conversation.
        check('booking flow still alive', asked.pendingAction === 'awaiting_viewing_selection', `pending=${asked.pendingAction}`);

        const lead = await getLeadState(p);
        const prof = await getProfile(lead.id);
        check('rejection recorded', (prof.rejected_property_ids || []).length === 1,
            `rejected=${JSON.stringify(prof.rejected_property_ids)}`);

        // Giving the reason should re-search rather than interrogate further.
        const after = await send(p, 'it was too expensive');
        check('re-ranked after hearing why', /F CFA/.test(after.reply), after.reply.slice(0, 200));
        const prof2 = await getProfile(lead.id);
        check('reason stored against that property',
            Object.keys(prof2.rejection_reasons || {}).length === 1,
            JSON.stringify(prof2.rejection_reasons));
    });

    await scenario('COMPARE: "compare 1 and 2" sets them side by side and steers', async (p) => {
        // "No preference" (not a real value) for both, deliberately — the
        // point of this scenario is that NO priority was stated, so the
        // composer must ask what matters rather than invent one. A real
        // budget/neighbourhood value would give it something genuine to
        // reason from, which is a different (also correct) behaviour tested
        // elsewhere, not what this scenario checks.
        await send(p, 'I want to rent a villa in Lome, any area is fine, any budget is fine');
        const r = await send(p, 'compare 1 and 2');
        // Facts come from the DB rows, so the real figures must be present.
        check('shows a side-by-side breakdown', /F CFA/.test(r.reply) && /\(1\)/.test(r.reply) && /\(2\)/.test(r.reply),
            r.reply.slice(0, 200));
        check('comparing does not end the booking flow',
            r.pendingAction === 'awaiting_viewing_selection', `pending=${r.pendingAction}`);
        // They stated no priorities, so it must ASK what matters rather than
        // inventing a preference for them.
        check('asks what matters instead of guessing a priority',
            /\?/.test(r.reply), r.reply.slice(-160));
    });

    // ── Scenarios 35-38: knowledge and objections ──

    await scenario('KNOWLEDGE: a property question is answered, not deflected', async (p) => {
        const r = await send(p, 'what is a cour commune?');
        check('actually answered it', /courtyard|cour/i.test(r.reply), r.reply.slice(0, 180));
        // It used to be classified off_topic and brushed aside.
        check('did not brush it off as off-topic',
            !/specialized in real estate search|spécialisé dans la recherche/i.test(r.reply), r.reply.slice(0, 180));
    });

    await scenario('KNOWLEDGE: admits ignorance rather than inventing law or money facts', async (p) => {
        // Nothing in the knowledge base covers agency commission. The bot must
        // NOT improvise a percentage — being fluently wrong about money is the
        // whole reason this layer is curated rather than model-generated.
        const r = await send(p, 'what percentage commission does the agency charge on a sale?');
        check('quoted no invented percentage', !/\d+\s*%/.test(r.reply), r.reply.slice(0, 200));
    });

    await scenario('OBJECTION: "too expensive" returns cheaper options, not another question', async (p) => {
        await send(p, 'I want to rent a villa in Lome, budget 500000, any area is fine');
        const r = await send(p, 'these are all too expensive for me');
        check('came back with listings rather than interrogating them',
            /F CFA/.test(r.reply), r.reply.slice(0, 200));

        const prof = await getProfile((await getLeadState(p)).id);
        check('budget ceiling lowered from what they rejected',
            prof.budget_max !== null && prof.budget_max < 350000, `budget_max=${prof.budget_max}`);
    });

    await scenario('OBJECTION: "I\'ll think about it" backs off instead of pushing', async (p) => {
        await send(p, 'I want to rent a villa in Lome, budget 500000, any area is fine');
        const r = await send(p, 'I will think about it');
        check('did not push a viewing',
            !/book|viewing|visite|réserver/i.test(r.reply), r.reply);
        check('flow left intact for their return',
            r.pendingAction === 'awaiting_viewing_selection', `pending=${r.pendingAction}`);
    });

    await scenario('REJECTION on price re-searches the SAME type, never drops it', async (p) => {
        const first = await send(p, 'I want to rent a villa in Lome, 4 bedrooms, budget 400000, any area is fine');
        const rejectedId = first.media && first.media[0] && first.media[0].id;
        // The villa they reject is the cheapest one that fits — with only 3
        // villas in the demo catalogue, rejecting it leaves nothing cheaper
        // of that type at all. That used to (a) let cheaper WRONG-TYPE
        // listings (single rooms, apartments) outrank the over-budget
        // correct-type ones, and, once type was locked, (b) pad the result
        // out with the same listing they just rejected (sunk but not
        // removed). Both are checked here.
        const r = await send(p, "I don't like the first one, too expensive");
        check('offered something', Array.isArray(r.media) && r.media.length > 0, r.reply.slice(0, 150));
        check('everything offered is still a villa (type not dropped)',
            (r.media || []).every((m) => m.type === 'villa'),
            `types=${(r.media || []).map((m) => m.type).join(',')}`);
        check('the just-rejected listing is not shown again',
            (r.media || []).every((m) => m.id !== rejectedId),
            `ids=${(r.media || []).map((m) => m.id).join(',')} rejectedId=${rejectedId}`);
    });

    await scenario('REQUEST_DETAILS: "tell me more about the 2nd one" answers in text, not photos', async (p) => {
        const first = await send(p, 'I want to rent a villa in Lome, budget 500000, any area is fine');
        const target = first.media && first.media[1]; // "the 2nd one"
        // "Tell me more" was previously conflated with "more pictures" purely
        // because both contain the word "more" — it re-sent photos and asked
        // "which one interests you most?", ignoring the question and re-asking
        // something they had already effectively answered by naming a listing.
        const r = await send(p, 'tell me more about the 2nd one');
        check('answered in text, no media sent', r.media === null, `media=${JSON.stringify(r.media)}`);
        check('names the actual listing asked about',
            Boolean(target) && r.reply.includes(target.neighbourhood),
            `expected=${target && target.neighbourhood} reply=${r.reply.slice(0, 200)}`);
        // Real bug: this used to re-append the FULL formatted card (numbered
        // heading, ✓/✗ reasons, "Contact:" line) below the composed answer —
        // the lead already saw that card once, so repeating it read as the
        // bot glitching rather than answering. Prose only, no card, now.
        check('does not repeat the formatted listing card',
            !/^\d+\.\s/m.test(r.reply) && !/Contact:/.test(r.reply), r.reply);
        check('asks about arranging a viewing, not "which one"',
            /viewing|visite|visit|see it|in person/i.test(r.reply) && !/which (property|one)|quel bien|lequel/i.test(r.reply),
            r.reply.slice(0, 250));
        check('booking flow still alive', r.pendingAction === 'awaiting_viewing_selection', `pending=${r.pendingAction}`);
    });

    await scenario('KNOWLEDGE mid-booking: a question is answered, not "I didn\'t catch that"', async (p) => {
        await send(p, 'I want to rent a villa in Lome, budget 500000, any area is fine');
        // Asked while choosing a listing, this used to hit the selection NLU,
        // classify as unclear, and get brushed off — a sensible question
        // penalised purely for its timing.
        const r = await send(p, 'what is a cour commune?');
        check('answered the question', /courtyard|cour/i.test(r.reply), r.reply.slice(0, 160));
        check("did not say it didn't understand",
            !/didn't quite catch|n'ai pas compris/i.test(r.reply), r.reply.slice(0, 160));
        check('booking flow survived', r.pendingAction === 'awaiting_viewing_selection', `pending=${r.pendingAction}`);
    });

    // ── Scenarios 40-42: qualifying-question order, and name capture ──

    await scenario('QUALIFYING ORDER: location questions lead with city, not neighbourhood', async (p) => {
        const r = await send(p, 'Hello');
        check('asks about city, not a bare "area"', /\bcity\b/i.test(r.reply), r.reply);
        check('does not lead with neighbourhood', !/^.*neighbourhood.*city/is.test(r.reply), r.reply);
    });

    await scenario('NAME: asked once at booking when nothing else supplied one, then stored', async (p) => {
        // send() always passes a contactName, which would give this lead a
        // name from turn one (exactly what the next scenario tests) — bypass
        // it here to actually simulate WhatsApp giving no profile name.
        const say = (t) => wh.processInboundMessage({ phone: p, text: t, contactName: null, messageType: 'text' });
        await say('I want to rent a villa in Lome, budget 500000, any area is fine');
        const ask = await say('1');
        check('asked for date AND name in one message',
            /name/i.test(ask.replyText) && /date|when/i.test(ask.replyText), ask.replyText);

        const booked = await say('Kofi, tomorrow 11am');
        const after = await getLeadState(p);
        check('booking still completed', !after.pendingAction, `pending=${after.pendingAction}`);
        const { rows } = await pool.query('SELECT name FROM leads WHERE id = $1', [after.id]);
        check('name stored', rows[0].name === 'Kofi', `name=${rows[0].name}`);

        // Re-ask must never nag for a name twice.
        const p2 = `${p}B`;
        await cleanup(p2);
        const say2 = (t) => wh.processInboundMessage({ phone: p2, text: t, contactName: null, messageType: 'text' });
        await say2('I want to rent a villa in Lome, budget 500000, any area is fine');
        await say2('1');
        const reAsk = await say2('not sure yet'); // unparseable -> re-ask
        check('re-ask does not ask for a name again', !/name/i.test(reAsk.replyText), reAsk.replyText);
        await cleanup(p2);
    });

    await scenario('NAME: a WhatsApp-supplied name is trusted, never re-asked', async (p) => {
        // send() always passes contactName: 'Smoke Test' — the equivalent of
        // WhatsApp already having supplied a profile name.
        await send(p, 'I want to rent a villa in Lome, budget 500000, any area is fine');
        const ask = await send(p, '1');
        check('does not ask for a name when one is already on file', !/name/i.test(ask.reply), ask.reply);
    });

    // ── Qualifying-question gate: ask neighbourhood, then budget, before searching ──

    await scenario('QUALIFYING GATE: asks neighbourhood then budget, one at a time, before searching', async (p) => {
        // City + type only — must NOT search yet.
        const r1 = await send(p, 'I want a villa in Lome');
        check('asked about area/neighbourhood', /neighbourhood|area|quartier|secteur/i.test(r1.reply), r1.reply);
        check('no listings shown', r1.media === null, `media=${JSON.stringify(r1.media)}`);

        // Neighbourhood given — must ask budget next, still not search.
        // (media === null, not a "F CFA" text check — the budget question
        // itself is instructed to mention "F CFA" as the currency, so that
        // substring can appear in a question with nothing searched yet.)
        const r2 = await send(p, 'Be');
        check('still did not search', r2.media === null, `media=${JSON.stringify(r2.media)}`);
        check('asked about budget', /budget/i.test(r2.reply), r2.reply);
        const prof2 = await getProfile((await getLeadState(p)).id);
        check('neighbourhood stored', prof2.neighbourhood === 'Bè', `neighbourhood=${prof2.neighbourhood}`);

        // Budget given — NOW it should search.
        const r3 = await send(p, '400000');
        check('searched once budget was given', /F CFA/.test(r3.reply), r3.reply.slice(0, 200));
        check('listings shown', Array.isArray(r3.media) && r3.media.length > 0, `media=${JSON.stringify(r3.media)}`);
    });

    await scenario('QUALIFYING GATE: all four criteria in one message searches immediately', async (p) => {
        // Nothing left to ask, so it must not interrogate them for facts
        // already given.
        const r = await send(p, 'I want a villa in Be, Lome, budget 400000');
        check('searched immediately', /F CFA/.test(r.reply), r.reply.slice(0, 200));
        check('listings shown', Array.isArray(r.media) && r.media.length > 0, `media=${JSON.stringify(r.media)}`);
    });

    await scenario('QUALIFYING GATE: explicit "no preference" for area skips straight to budget', async (p) => {
        await send(p, 'I want an apartment in Lome');
        const r = await send(p, 'any area is fine');
        check('did not search yet', r.media === null, `media=${JSON.stringify(r.media)}`);
        check('asked about budget, not area again', /budget/i.test(r.reply), r.reply);
        const prof = await getProfile((await getLeadState(p)).id);
        check('no_preference flag stored', prof.neighbourhood_no_preference === true, `flag=${prof.neighbourhood_no_preference}`);

        const r2 = await send(p, '150000');
        check('now searches once budget is given', /F CFA/.test(r2.reply), r2.reply.slice(0, 200));
    });

    // ── The two reported bugs, end to end through the real router ──

    await scenario('HARD GATE bug 1: "I want a villa to rent" must ask CITY, not search', async (p) => {
        // Reported: this searched and dumped 3 villas + photos immediately,
        // with neither a city nor a budget known. The old gate could not fire
        // because it required city to already be set.
        const r = await send(p, 'I want a villa to rent');
        check('sent NO listings', r.media === null, `media=${JSON.stringify(r.media)}`);
        check('printed no listing card', !/^\d+\.\s.+F CFA/m.test(r.reply), r.reply.slice(0, 200));
        check('asked which city', /city|town|ville|Lom/i.test(r.reply), r.reply);
    });

    await scenario('HARD GATE bug 2: "Not villa" with no budget must ask, not re-search', async (p) => {
        // Reported: changing their mind on type triggered an immediate search
        // for other types while budget was still unknown.
        const setup = await send(p, 'I want a villa in Lome');
        check('setup showed nothing (budget still unknown)', setup.media === null, `media=${JSON.stringify(setup.media)}`);

        const r = await send(p, 'Not villa');
        check('sent NO listings', r.media === null, `media=${JSON.stringify(r.media)}`);
        check('printed no listing card', !/^\d+\.\s.+F CFA/m.test(r.reply), r.reply.slice(0, 250));

        // And once budget finally arrives, it may search normally again.
        const after = await send(p, 'my budget is 150000');
        check('searches once budget is known', Array.isArray(after.media) && after.media.length > 0,
            `media=${JSON.stringify(after.media)}`);
    });

    await scenario('NLU SCHEMA: the extraction call actually parses (union-parameter limit)', async () => {
        // Guards a near-miss that broke EVERY extraction at once. The
        // Anthropic structured-output API rejects a schema with more than 16
        // union-typed parameters, and every `.nullable()` field is a union.
        // NLUSchema sits at exactly 16; adding one more nullable field made
        // the API return 400 and extractSearchFilters fall back to intent
        // 'unclear' with all filters null — the bot silently understood
        // nothing, while still replying fluently. Only stderr showed it.
        //
        // A rich message must therefore come back POPULATED, not as the
        // all-null fallback. If this fails after adding an NLU field, use a
        // sentinel enum value instead of .nullable().
        const f = await wh.extractSearchFilters('I want to rent a villa in Lome with 3 bedrooms, budget 400000', [], null);
        check('schema was accepted (fields populated, not the null fallback)',
            f.city !== null && f.type !== null && f.price_max !== null,
            `city=${f.city} type=${f.type} price_max=${f.price_max} intent=${f.intent}`);
    });

    await scenario('EXCLUDED TYPE: "not villa" removes villas AND the intro tells the truth', async (p) => {
        // Reported: the intro announced "here are properties that aren't
        // villas" and then listed a villa as #1. Two faults in one — "not
        // villa" only NULLed property_type (so the search was unconstrained
        // and villas ranked normally), and the composer invented an exclusion
        // claim from the transcript that nothing in the code had performed.
        const first = await send(p, 'I want a villa in Be, Lome, budget 400000');
        check('setup showed villas', (first.media || []).some((m) => m.type === 'villa'),
            `types=${(first.media || []).map((m) => m.type).join(',')}`);

        const r = await send(p, 'Not villa');
        check('re-searched rather than getting stuck',
            Array.isArray(r.media) && r.media.length > 0, r.reply.slice(0, 200));
        check('NO villa in the results',
            (r.media || []).every((m) => m.type !== 'villa'),
            `types=${(r.media || []).map((m) => m.type).join(',')}`);
        // The card body is rendered from the DB, so a villa card appearing
        // would contradict any "no villas" intro regardless of wording.
        check('no villa card rendered', !/^\d+\.\s*Villa/m.test(r.reply), r.reply.slice(0, 250));

        const prof = await getProfile((await getLeadState(p)).id);
        check('exclusion recorded on the profile',
            (prof.excluded_types || []).includes('villa'), `excluded_types=${JSON.stringify(prof.excluded_types)}`);

        // Changing their mind must un-exclude it — continuing to filter out
        // something they have just asked for is the same failure in reverse.
        const back = await send(p, 'actually show me a villa after all');
        const prof2 = await getProfile((await getLeadState(p)).id);
        check('asking for the type again un-excludes it',
            !(prof2.excluded_types || []).includes('villa'), `excluded_types=${JSON.stringify(prof2.excluded_types)}`);
        check('villas are shown again', (back.media || []).some((m) => m.type === 'villa'),
            `types=${(back.media || []).map((m) => m.type).join(',')}`);
    });

    console.log(`\n${'='.repeat(72)}`);
    if (skipped > 0) {
        // Stated loudly: a green partial run is not a green suite, and this
        // line is the difference between "verified" and "probably fine".
        console.log(`PARTIAL RUN — ${skipped} scenario(s) skipped. Run without arguments before committing.`);
    }
    console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    console.log('all test leads cleaned up.\n');
    process.exit(failures === 0 ? 0 : 1);
};

run().catch(async (err) => {
    console.error('\nSUITE CRASHED:', err);
    process.exit(1);
});
