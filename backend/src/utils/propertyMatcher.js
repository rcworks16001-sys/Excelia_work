// ── Property matching and ranking ──
//
// Replaces `ORDER BY price ASC`, which was the only ranking the bot ever had.
// That ordering is actively wrong for a lead with a budget: someone who says
// "up to 400 000" was shown the 35 000 single room first, every time.
//
// WHY THIS SCORES IN JS RATHER THAN SQL: a weighted score computed over rows
// that already passed a hard WHERE on the same fields is constant — every
// surviving row matches every criterion, so the "ranking" provably reorders
// nothing. Scoring only means something if near-misses are allowed into the
// candidate set. So the SQL side keeps just one hard filter (availability) and
// everything else is soft, scored, and explained.
//
// It also subsumes the old relaxation cascade: instead of silently widening the
// search and apologising afterwards, a 2-bedroom at 85 000 when they asked for
// 3 at 90 000 simply appears lower down, marked "✗ 2 bedrooms, not 3". The lead
// sees the trade-off and decides, which is more honest than either silently
// substituting or dead-ending.

const { PROPERTY_TYPE_LABELS } = require('./language');
const { formatXOF } = require('./format');

// Weights sum to 100 so a score reads as a percentage to a human. Ordering
// reflects how badly a mismatch wastes the lead's time: being shown a place to
// buy when you want to rent is worse than being shown one extra bedroom.
const WEIGHTS = {
    transaction: 25,
    budget: 25,
    location: 20,
    type: 15,
    bedrooms: 15,
};

// How far over budget a listing can be before it scores nothing at all.
// Beyond ~40% over, showing it is not a helpful stretch — it is a different
// conversation.
const BUDGET_OVERSHOOT_LIMIT = 0.4;

const labelFor = (type, lang) => PROPERTY_TYPE_LABELS[type]?.[lang] ?? type;

// ── scoreProperty(property, filters, lang) ──
// Returns { score, reasons }. `reasons` contains ONLY criteria the lead
// actually stated — this matters more than it looks. BASE_PERSONA forbids
// implying results match something the customer never asked for, and printing
// "✓ Within your budget" at someone who never gave a budget is exactly that.
// No stated criterion, no reason line.
const scoreProperty = (property, filters = {}, lang = 'fr') => {
    const reasons = [];
    let earned = 0;
    let available = 0;

    // ── Transaction ──
    if (filters.transaction) {
        available += WEIGHTS.transaction;
        const matched = property.transaction === filters.transaction;
        if (matched) earned += WEIGHTS.transaction;
        reasons.push({
            key: 'transaction',
            matched,
            label: matched
                ? (filters.transaction === 'sale'
                    ? (lang === 'fr' ? 'À vendre' : 'For sale')
                    : (lang === 'fr' ? 'À louer' : 'For rent'))
                : (property.transaction === 'sale'
                    ? (lang === 'fr' ? 'À vendre, pas à louer' : 'For sale, not for rent')
                    : (lang === 'fr' ? 'À louer, pas à vendre' : 'For rent, not for sale')),
        });
    }

    // ── Budget ──
    // Under budget is full marks — cheaper is never a mismatch. Over budget
    // decays linearly to zero at BUDGET_OVERSHOOT_LIMIT.
    const budget = filters.price_ceiling || filters.price_max;
    if (budget) {
        available += WEIGHTS.budget;
        const overshoot = (property.price - budget) / budget;
        if (overshoot <= 0) {
            earned += WEIGHTS.budget;
            reasons.push({
                key: 'budget',
                matched: true,
                label: lang === 'fr' ? 'Dans votre budget' : 'Within your budget',
            });
        } else if (overshoot < BUDGET_OVERSHOOT_LIMIT) {
            earned += WEIGHTS.budget * (1 - overshoot / BUDGET_OVERSHOOT_LIMIT);
            reasons.push({
                key: 'budget',
                matched: false,
                label: lang === 'fr'
                    ? `${formatXOF(property.price - budget)} au-dessus de votre budget`
                    : `${formatXOF(property.price - budget)} over your budget`,
            });
        } else {
            reasons.push({
                key: 'budget',
                matched: false,
                label: lang === 'fr' ? 'Bien au-dessus de votre budget' : 'Well over your budget',
            });
        }
    }

    // ── Location ──
    // Neighbourhood is what they asked for; the same city is a partial match
    // worth saying out loud rather than silently substituting.
    // Accent-insensitive, matching the unaccent() the SQL side already uses —
    // French WhatsApp input routinely drops accents ("lome" for "Lomé").
    const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (filters.neighbourhood) {
        available += WEIGHTS.location;
        const exact = norm(property.neighbourhood).includes(norm(filters.neighbourhood));
        const sameCity = filters.city && norm(property.city).includes(norm(filters.city));
        if (exact) {
            earned += WEIGHTS.location;
            reasons.push({ key: 'location', matched: true, label: property.neighbourhood });
        } else if (sameCity) {
            earned += WEIGHTS.location * 0.5;
            reasons.push({
                key: 'location',
                matched: false,
                label: lang === 'fr'
                    ? `${property.neighbourhood}, pas ${filters.neighbourhood}`
                    : `${property.neighbourhood}, not ${filters.neighbourhood}`,
            });
        } else {
            reasons.push({
                key: 'location',
                matched: false,
                label: `${property.neighbourhood}, ${property.city}`,
            });
        }
    } else if (filters.city) {
        available += WEIGHTS.location;
        const matched = norm(property.city).includes(norm(filters.city));
        if (matched) earned += WEIGHTS.location;
        reasons.push({
            key: 'location',
            matched,
            label: matched ? property.city : `${property.city}, ${lang === 'fr' ? 'pas' : 'not'} ${filters.city}`,
        });
    }

    // ── Type ──
    if (filters.type) {
        available += WEIGHTS.type;
        const matched = property.type === filters.type;
        if (matched) earned += WEIGHTS.type;
        reasons.push({
            key: 'type',
            matched,
            label: matched
                ? labelFor(property.type, lang)
                : `${labelFor(property.type, lang)}, ${lang === 'fr' ? 'pas' : 'not'} ${labelFor(filters.type, lang)}`,
        });
    }

    // ── Bedrooms ──
    // A range ("2 or 3 bedrooms") is expressible here in a way the old exact
    // `bedrooms = $n` SQL never was. One bedroom out is a near miss worth
    // showing; further than that is not what they asked for.
    const min = filters.bedrooms_min ?? filters.bedrooms;
    const max = filters.bedrooms_max ?? filters.bedrooms;
    if (min != null || max != null) {
        available += WEIGHTS.bedrooms;
        const beds = property.bedrooms;
        const word = lang === 'fr' ? 'chambre(s)' : 'bedroom(s)';
        if (beds == null) {
            // Land has no bedrooms — not a mismatch to explain, just no signal.
            reasons.push({ key: 'bedrooms', matched: false, label: lang === 'fr' ? 'Terrain nu' : 'Bare land' });
        } else {
            const lo = min ?? beds;
            const hi = max ?? beds;
            const inRange = beds >= lo && beds <= hi;
            const nearMiss = !inRange && (beds === lo - 1 || beds === hi + 1);
            if (inRange) earned += WEIGHTS.bedrooms;
            else if (nearMiss) earned += WEIGHTS.bedrooms * 0.5;
            const wanted = lo === hi ? `${lo}` : `${lo}-${hi}`;
            reasons.push({
                key: 'bedrooms',
                matched: inRange,
                label: inRange
                    ? `${beds} ${word}`
                    : `${beds} ${word}, ${lang === 'fr' ? 'pas' : 'not'} ${wanted}`,
            });
        }
    }

    // Scored as a percentage of what was actually asked for, so a lead who
    // stated one criterion isn't capped at 25/100 for it. With no criteria at
    // all everything ties, and the tie-break below decides.
    const score = available === 0 ? 0 : Math.round((earned / available) * 100);
    return { score, reasons };
};

// ── rankProperties(properties, filters, { limit, lang, rejectedIds, lockType }) ──
// The whole candidate set in, the best few out, each carrying its reasons.
//
// lockType: makes a stated `filters.type` a HARD filter for this call only,
// instead of the usual soft 15-point criterion. Exists for the price-driven
// re-search after a rejection/objection (webhookController.js): WEIGHTS.budget
// (25) + WEIGHTS.location (20) together outweigh WEIGHTS.type (15), so once a
// budget ceiling is pushed below every listing of the stated type, a cheaper
// WRONG-TYPE listing can out-score an over-budget CORRECT-TYPE one — a lead
// who rejected a villa as "too expensive" would be shown single rooms. Locking
// type for that one call keeps ranking (and its honest ✗ budget reasons)
// scoped to the type they actually asked for. Falls back to the full pool if
// no listing of that type exists at all, so a genuine catalogue gap never
// dead-ends the reply.
const rankProperties = (properties, filters = {}, { limit = 3, lang = 'fr', rejectedIds = [], lockType = false } = {}) => {
    const rejected = new Set(rejectedIds || []);

    let candidatePool = properties;
    if (lockType && filters.type) {
        const sameType = properties.filter((p) => p.type === filters.type);
        if (sameType.length > 0) candidatePool = sameType;
    }

    const scored = candidatePool.map((property) => {
        const { score, reasons } = scoreProperty(property, filters, lang);
        return { ...property, matchScore: score, matchReasons: reasons };
    });

    const byScoreThenPrice = (a, b) => {
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        // Cheapest first among equals — the old behaviour, now only a
        // tie-break rather than the entire ranking.
        return a.price - b.price;
    };

    // Anything they have explicitly turned down is excluded from the normal
    // ranking, not just sunk to the bottom — a rejected listing padding out
    // an otherwise-short result set looks like the bot didn't hear the
    // rejection (this surfaced with lockType: with only a few listings of one
    // type, "sink but keep in the slice" meant the JUST-rejected villa could
    // still fill the last of 3 slots, over-budget-labelled at literally the
    // ceiling it itself defined). It only reappears as an actual last
    // resort — zero non-rejected candidates at all — because showing it then
    // still beats showing nothing.
    const nonRejected = scored.filter((s) => !rejected.has(s.id)).sort(byScoreThenPrice);
    const rejectedOnly = scored.filter((s) => rejected.has(s.id)).sort(byScoreThenPrice);
    const listings = (nonRejected.length > 0 ? nonRejected : rejectedOnly).slice(0, limit);

    // Which stated criteria the BEST result still fails. Feeds the intro line
    // so it can be honest up front ("no exact match") rather than leaving the
    // lead to infer it from the per-listing marks.
    const relaxed = listings.length
        ? listings[0].matchReasons.filter((r) => !r.matched).map((r) => r.key)
        : [];

    return { listings, relaxed };
};

module.exports = { scoreProperty, rankProperties, WEIGHTS };
