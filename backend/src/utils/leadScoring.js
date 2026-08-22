// ── Lead scoring ──
//
// Turns what we know about a lead into one number the agency can sort by, so
// the person with 40 conversations in the dashboard knows who to call first.
//
// Pure and synchronous: it takes a profile plus a few counters and returns a
// score. No DB, no LLM. That keeps it free, instant, testable, and — the real
// point — explainable: every point is attributable to something the lead
// actually did, so "why is this lead hot?" has an answer.
//
// Adapted from the client's blueprint for this market and channel. The
// blueprint awards points for providing a phone number; on WhatsApp we have it
// from the first message, so that signal carries no information and is dropped
// rather than given to everyone equally.

const SIGNALS = [
    // What they want — each specific detail is evidence of a real requirement
    // rather than idle browsing.
    { key: 'stated_type', points: 10, when: (p) => Boolean(p.property_type) },
    { key: 'stated_location', points: 10, when: (p) => Boolean(p.city || p.neighbourhood) },
    { key: 'stated_budget', points: 10, when: (p) => Boolean(p.budget_max || p.budget_stretch_max) },
    { key: 'stated_purpose', points: 5, when: (p) => Boolean(p.purpose) },

    // Timeline — the strongest single predictor of whether this becomes a deal.
    { key: 'timeline_immediate', points: 20, when: (p) => p.timeline === 'immediate' || p.timeline === 'within_1_month' },
    { key: 'timeline_soon', points: 10, when: (p) => p.timeline === 'within_3_months' },

    // Engagement with actual inventory beats any stated intention.
    { key: 'liked_a_property', points: 15, when: (p) => (p.liked_property_ids || []).length > 0 },
    { key: 'booked_a_viewing', points: 25, when: (p, c) => c.appointmentCount > 0 },
    { key: 'asked_for_human', points: 20, when: (p) => p.needs_human === true },
    { key: 'repeat_engagement', points: 5, when: (p, c) => c.messageCount >= 6 },

    // Negative signals. Someone explicitly just looking is not a lead to chase,
    // and saying so should visibly cost them points rather than being ignored.
    { key: 'just_exploring', points: -10, when: (p) => p.timeline === 'exploring' },
    { key: 'timeline_distant', points: -10, when: (p) => p.timeline === 'later' },
    { key: 'rejected_everything', points: -5, when: (p) => (p.rejected_property_ids || []).length >= 3 && (p.liked_property_ids || []).length === 0 },
];

// Bands. Deliberately coarse — the number's job is to sort a work queue, and
// finer gradations would imply a precision this evidence does not have.
const TEMPERATURE_BANDS = [
    { name: 'hot', min: 70 },
    { name: 'warm', min: 45 },
    { name: 'qualified', min: 25 },
    { name: 'cold', min: -Infinity },
];

// ── scoreLead(profile, counters) ──
// counters: { appointmentCount, messageCount }
// Returns { score, temperature, reasons } — `reasons` is what makes the number
// defensible in the dashboard instead of a mystery.
const scoreLead = (profile, counters = {}) => {
    const p = profile || {};
    const c = { appointmentCount: 0, messageCount: 0, ...counters };

    const reasons = [];
    let score = 0;
    for (const signal of SIGNALS) {
        if (signal.when(p, c)) {
            score += signal.points;
            reasons.push({ key: signal.key, points: signal.points });
        }
    }

    // Clamped: negatives shouldn't produce a nonsensical figure, and the top of
    // the range is 100 so the bands read as percentages to a human.
    score = Math.max(0, Math.min(100, score));
    const temperature = TEMPERATURE_BANDS.find((b) => score >= b.min).name;

    return { score, temperature, reasons };
};

module.exports = { scoreLead, SIGNALS, TEMPERATURE_BANDS };
