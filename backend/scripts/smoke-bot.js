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

// ── EXCELIA bot smoke test ──
// Run manually:  npm run smoke-bot
//
// WHY THIS EXISTS: an earlier round of verification re-implemented the handler
// logic inline instead of calling the real functions. That copy happened to
// have `history` in scope, so it passed — while the real
// handleViewingSelectionReply was throwing "ReferenceError: history is not
// defined" on EVERY reply after a listing set, and the lead just saw
// "Sorry, something went wrong." Testing a reimplementation proves nothing
// about the real code path.
//
// So this script calls the ACTUAL exported handlers. It catches undefined
// variables, changed return shapes and broken booking transitions that
// `node -c` cannot see. No WhatsApp messages are sent — only the reply text
// is computed. Uses a disposable lead and deletes it (plus any appointment it
// creates) at the end.

const TEST_PHONE = '999000777888';
const HISTORY_TURNS = 10;

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) {
        failures += 1;
        if (detail) console.log(`         ${detail}`);
    }
};

const cleanup = async () => {
    const s = await getLeadState(TEST_PHONE);
    if (s) await pool.query('DELETE FROM appointments WHERE lead_id = $1', [s.id]);
    await pool.query('DELETE FROM leads WHERE phone = $1', [TEST_PHONE]);
};

// Drives one inbound text message through the REAL handlers.
const send = async (text) => {
    const before = await getLeadState(TEST_PHONE);
    const history = before ? await getRecentConversation(before.id, HISTORY_TURNS) : [];
    const inPending = Boolean(before && before.pendingAction);
    const understanding = inPending ? null : await wh.extractSearchFilters(text, history);

    const switchReq = detectLanguageSwitchRequest(text) || (understanding && understanding.language_request) || null;
    const words = text.split(/\s+/).filter(Boolean).length;
    let lang;
    if (switchReq) lang = switchReq;
    else if (before && (inPending || words <= 3)) lang = before.language;
    else lang = (understanding && understanding.message_language) || (before && before.language) || DEFAULT_LANGUAGE;

    const lead = await getOrCreateLead(TEST_PHONE, 'Smoke Test', lang);
    await saveConversationMessage(lead.id, 'user', text);

    let reply = null;
    let media = null;
    let route = '';

    if (lead.pendingAction === 'awaiting_viewing_selection') {
        const r = await wh.handleViewingSelectionReply({
            leadId: lead.id, text, lang, pendingListingIds: lead.pendingListingIds, history,
        });
        route = 'selection';
        if (r === null) route = 'selection->new_search';
        else {
            reply = r.text;
            media = r.mediaListings;
        }
    } else if (lead.pendingAction === 'awaiting_viewing_datetime') {
        reply = await wh.handleViewingDateTimeReply({
            leadId: lead.id, propertyId: lead.pendingPropertyId, text, lang, history,
        });
        route = 'datetime';
    }

    if (reply === null) {
        const f = route === 'selection->new_search'
            ? await wh.extractSearchFilters(text, history)
            : understanding;
        route = route || `intent:${f.intent}`;
        if (switchReq && f.intent !== 'search') {
            reply = await rc.composeLanguageSwitch({ lang, history });
        } else if (f.intent === 'closing') {
            reply = await rc.composeClosing({ lang, userMessage: text, history, justBooked: true });
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
    const after = await getLeadState(TEST_PHONE);
    console.log(`\n   > ${text}`);
    console.log(`     [${lang} | ${route} | pending=${after.pendingAction || 'none'}${media ? ` | media x${media.length}` : ''}]`);
    console.log(`   < ${reply.split('\n')[0]}`);
    return { reply, media, lang, route, pendingAction: after.pendingAction };
};

const run = async () => {
    await cleanup();
    console.log('\n=== EXCELIA bot smoke test (no WhatsApp messages sent) ===');

    console.log('\n1. Search');
    const r1 = await send('I am looking for a 1bhk');
    check('returned listings', /F CFA/.test(r1.reply));
    check('moved into selection state', r1.pendingAction === 'awaiting_viewing_selection');

    console.log('\n2. Ask for photos of a listing (the reported crash)');
    const r2 = await send('Can you share some photos of 1.');
    check('did NOT hit the error fallback', !r2.reply.includes(BOT_STRINGS.error_fallback.en));
    check('resent media for that one listing', Array.isArray(r2.media) && r2.media.length === 1);
    check('stayed in selection state (no jump to date/time)', r2.pendingAction === 'awaiting_viewing_selection');

    // In the reported conversation this line was the lead CLARIFYING which
    // listing they wanted photos of, so continuing to treat it as a media
    // request (not a booking) is the correct, context-aware reading.
    console.log('\n3. Clarifying the photo request (the second crashing message)');
    const r3 = await send('I mean 1st option in the list you gave');
    check('did NOT hit the error fallback', !r3.reply.includes(BOT_STRINGS.error_fallback.en));
    check('read it in context and did not derail the flow',
        r3.pendingAction === 'awaiting_viewing_selection', `pending became ${r3.pendingAction}`);

    console.log('\n4. Pick a listing');
    const r4 = await send('1');
    check('moved on to asking for a date',
        r4.pendingAction === 'awaiting_viewing_datetime', `pending became ${r4.pendingAction}`);

    console.log('\n5. Give a real date');
    const r5 = await send('tomorrow 11am');
    check('booking flow cleared', !r5.pendingAction, `pending is ${r5.pendingAction}`);
    const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM appointments WHERE lead_id = (SELECT id FROM leads WHERE phone = $1)',
        [TEST_PHONE]
    );
    check('appointment row written', rows[0].n === 1, `found ${rows[0].n}`);

    console.log('\n6. "Thank you" must not trigger a welcome');
    const r6 = await send('Thank you');
    check('no welcome message', !/welcome to excelia/i.test(r6.reply));

    console.log('\n7. Language switch on a natural phrasing');
    const r7 = await send('Now please french');
    check('switched to French', r7.lang === 'fr');

    console.log('\n8. Must NOT claim a booking that was never made');
    await cleanup();
    await send('hello');
    const r8 = await send('I want to book a viewing please');
    const claimsBooking = /(confirmed|booked|registered)|let the team know|team will (call|contact|confirm)|est confirm|j'ai transmis/i.test(r8.reply);
    const { rows: r8rows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM appointments WHERE lead_id = (SELECT id FROM leads WHERE phone = $1)',
        [TEST_PHONE]
    );
    check('no appointment actually exists', r8rows[0].n === 0, `found ${r8rows[0].n}`);
    check('reply does not claim a booking exists', !claimsBooking, r8.reply);

    await cleanup();
    console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`);
    console.log('test lead cleaned up.\n');
    process.exit(failures === 0 ? 0 : 1);
};

run().catch(async (err) => {
    console.error('\nSMOKE TEST CRASHED:', err);
    await cleanup().catch(() => {});
    process.exit(1);
});
