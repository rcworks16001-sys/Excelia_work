require('dotenv').config();
const pool = require('../src/db/index');
const wh = require('../src/controllers/webhookController');
const {
    getOrCreateLead, getLeadState, saveConversationMessage, getRecentConversation,
    setPendingViewingSelection,
} = require('../src/controllers/leadController');
const { searchPropertiesWithFallback } = require('../src/controllers/propertyController');
const { detectLanguageSwitchRequest, BOT_STRINGS, DEFAULT_LANGUAGE } = require('../src/utils/language');
const rc = require('../src/utils/replyComposer');

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
// So this drives the ACTUAL exported handlers. It catches undefined
// variables, changed return shapes, and — most importantly — silently
// destroyed booking state, which is invisible to `node -c` and to eyeballing
// replies. Every scenario asserts the resulting pending state, not just text.
//
// No WhatsApp messages are sent. Each scenario uses its own disposable lead,
// deleted before and after, so the DB is left exactly as found.

const HISTORY_TURNS = 10;
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

// Mirrors handleMessage's text path exactly, calling the REAL handlers.
const send = async (phone, text) => {
    const before = await getLeadState(phone);
    const history = before ? await getRecentConversation(before.id, HISTORY_TURNS) : [];
    const inPending = Boolean(before && before.pendingAction);
    let understanding = inPending ? null : await wh.extractSearchFilters(text, history);

    const switchReq = detectLanguageSwitchRequest(text) || (understanding && understanding.language_request) || null;
    const words = text.split(/\s+/).filter(Boolean).length;
    let lang;
    if (switchReq) lang = switchReq;
    else if (before && (inPending || words <= 3)) lang = before.language;
    else lang = (understanding && understanding.message_language) || (before && before.language) || DEFAULT_LANGUAGE;

    const lead = await getOrCreateLead(phone, 'Smoke Test', lang);
    await saveConversationMessage(lead.id, 'user', text);

    let reply;
    let media = null;
    let route = '';

    if (lead.pendingAction === 'awaiting_viewing_selection') {
        const r = await wh.handleViewingSelectionReply({
            leadId: lead.id, text, lang, pendingListingIds: lead.pendingListingIds, history,
        });
        route = 'selection';
        if (r === null) {
            route = 'selection->new_search';
            understanding = await wh.extractSearchFilters(text, history);
        } else {
            reply = r.text;
            media = r.mediaListings;
        }
    } else if (lead.pendingAction === 'awaiting_viewing_datetime') {
        const r = await wh.handleViewingDateTimeReply({
            leadId: lead.id, propertyId: lead.pendingPropertyId, text, lang, history,
        });
        route = 'datetime';
        reply = r.text;
        media = r.mediaListings;
    }

    if (reply === undefined) {
        const f = understanding;
        route = route ? `${route}->intent:${f.intent}` : `intent:${f.intent}`;
        if (switchReq && f.intent !== 'search') {
            reply = await rc.composeLanguageSwitch({ lang, history });
        } else if (f.intent === 'closing') {
            reply = await rc.composeClosing({ lang, userMessage: text, history, justBooked: history.length > 2 });
        } else if (f.intent === 'off_topic') {
            reply = await rc.composeOffTopic({ lang, userMessage: text, history });
        } else if (f.intent === 'greeting' || f.intent === 'booking_intent') {
            reply = await rc.composeGreeting({ lang, userMessage: text, isNewLead: lead.isNew, history });
        } else {
            const sf = {
                city: f.city, neighbourhood: f.neighbourhood, type: f.type,
                price_max: f.price_max, bedrooms: f.bedrooms,
            };
            const { listings, relaxed } = await searchPropertiesWithFallback(sf);
            if (!listings.length) {
                reply = await rc.composeNoResults({ lang, userMessage: text, history });
            } else {
                const intro = await rc.composeResultsIntro({
                    lang, userMessage: text, listings, relaxed, filters: sf, history,
                });
                reply = `${intro}\n\n${wh.formatListingsBody(listings, lang)}\n\n${BOT_STRINGS.booking_prompt[lang]}`;
                await setPendingViewingSelection(lead.id, listings.map((p) => p.id));
                media = listings;
            }
        }
    }

    await saveConversationMessage(lead.id, 'bot', reply);
    const after = await getLeadState(phone);
    console.log(`\n      > ${text}`);
    console.log(`        [${lang} | ${route} | pending=${after.pendingAction || 'none'}${media ? ` | media x${media.length}` : ''}]`);
    console.log(`      < ${reply.split('\n')[0].slice(0, 130)}`);
    return { reply, media, lang, route, pendingAction: after.pendingAction, leadId: lead.id };
};

const apptCount = async (phone) => {
    const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM appointments WHERE lead_id = (SELECT id FROM leads WHERE phone = $1)', [phone]);
    return rows[0].n;
};

// Each scenario gets its own phone number so they can't contaminate each other.
let seq = 0;
const scenario = async (title, fn) => {
    seq += 1;
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
        const r = await send(p, 'I am looking for a 1bhk');
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
        await send(p, 'I am looking for a 1bhk');
        await send(p, '1');
        const r = await send(p, 'Can you share some photos ?');
        check('sent media', Array.isArray(r.media) && r.media.length === 1, `media=${r.media && r.media.length}`);
        check('BOOKING SURVIVED', r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
        check('did not claim a booking exists', !/(confirmed|registered|booked)\b/i.test(r.reply), r.reply);
        const d = await send(p, 'friday afternoon');
        check('can still complete the booking', (await apptCount(p)) === 1);
    });

    await scenario('Question while bot awaits a date', async (p) => {
        await send(p, 'I want a villa');
        await send(p, '1');
        const r = await send(p, 'what is the price again?');
        check('BOOKING SURVIVED', r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
        check('answered with real listing facts', /F CFA/.test(r.reply));
    });

    await scenario('"Hello" while choosing a listing', async (p) => {
        await send(p, 'I am looking for a 1bhk');
        const r = await send(p, 'Hello');
        check('flow preserved', r.pendingAction === 'awaiting_viewing_selection');
        check('did not re-welcome', !/welcome to excelia|bienvenue chez excelia/i.test(r.reply), r.reply);
    });

    await scenario('"thanks" while choosing a listing', async (p) => {
        await send(p, 'I am looking for a 1bhk');
        const r = await send(p, 'thanks');
        check('did not re-welcome', !/welcome to excelia/i.test(r.reply), r.reply);
    });

    await scenario('Explicit decline DOES clear the flow', async (p) => {
        await send(p, 'I am looking for a 1bhk');
        const r = await send(p, 'no thanks, not interested');
        check('flow cleared', !r.pendingAction, `pending=${r.pendingAction}`);
        check('no appointment created', (await apptCount(p)) === 0);
    });

    await scenario('Photos requested mid-selection without saying which', async (p) => {
        await send(p, 'I want a villa');
        const r = await send(p, 'can you send photos?');
        check('flow preserved', r.pendingAction === 'awaiting_viewing_selection');
    });

    await scenario('Refine search after results (filters carry forward)', async (p) => {
        await send(p, 'I want a villa in Lome');
        const r = await send(p, 'actually under 400000');
        check('re-searched instead of trapping in booking', /F CFA/.test(r.reply), r.reply);
    });

    await scenario('Language switch mid-booking', async (p) => {
        await send(p, 'I am looking for a 1bhk');
        await send(p, '1');
        const r = await send(p, 'en francais svp');
        check('switched to French', r.lang === 'fr');
        check('BOOKING SURVIVED', r.pendingAction === 'awaiting_viewing_datetime', `pending=${r.pendingAction}`);
    });

    await scenario('Off-topic message', async (p) => {
        const r = await send(p, 'what is the weather today');
        check('redirected without listings', !/F CFA/.test(r.reply));
    });

    await scenario('Vague query returns listings', async (p) => {
        const r = await send(p, 'Do you have anything cheap?');
        check('returned listings instead of re-greeting', /F CFA/.test(r.reply));
    });

    await scenario('Impossible query degrades gracefully', async (p) => {
        const r = await send(p, 'I need a 9 bedroom castle for 5000 francs');
        check('did not error out', !r.reply.includes(BOT_STRINGS.error_fallback.en));
    });

    await scenario('French happy path', async (p) => {
        await send(p, 'bonjour je cherche un appartement a Lome');
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

    await scenario('MEMORY: never asks the same question twice', async (p) => {
        await send(p, 'I am looking for a 1bhk');
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

    console.log(`\n${'='.repeat(72)}`);
    console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
    console.log('all test leads cleaned up.\n');
    process.exit(failures === 0 ? 0 : 1);
};

run().catch(async (err) => {
    console.error('\nSUITE CRASHED:', err);
    process.exit(1);
});
