const Anthropic = require('@anthropic-ai/sdk');

// The ONE place French listing copy gets translated to English. Same pattern
// as utils/language.js (its own client, same small model) — import this, never
// re-implement a translation call elsewhere.
//
// IMPORTANT — this is deliberately a WRITE-TIME helper, not a read-time one.
// Every caller must persist the result (properties.description_en) so a given
// string is translated exactly ONCE, ever. Never call this from a request
// handler that runs per page-view or per bot reply: that would add latency to
// every WhatsApp message, cost money per view, and produce slightly different
// wording each time.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TRANSLATION_MODEL = 'claude-haiku-4-5-20251001';

// Domain vocabulary, kept consistent with PROPERTY_TYPE_LABELS in
// utils/language.js so a translated description never disagrees with the
// type label shown right above it.
const GLOSSARY = [
    'chambre salon -> single room',
    'appartement -> apartment',
    'appartement meublé -> furnished apartment',
    'villa -> villa',
    'terrain -> land / plot',
    'mini-villa -> mini-villa',
    'chambres -> bedrooms',
    'cour commune -> shared courtyard',
    'titre foncier -> land title',
    'quartier -> neighbourhood',
].join('\n');

// ── translateToEnglish(frenchText) ──
// Returns the English translation, or null if translation isn't possible
// (empty input, API failure). Never throws — callers treat null as "leave it
// untranslated for now", so a failed translation degrades to showing the
// French original rather than breaking a migration or a page.
const translateToEnglish = async (frenchText) => {
    if (!frenchText || !frenchText.trim()) return null;

    try {
        const response = await anthropic.messages.create({
            model: TRANSLATION_MODEL,
            max_tokens: 500,
            temperature: 0,
            system: `You translate French real-estate listing descriptions (Togo market) into natural English.

Rules:
- Output ONLY the translated sentence. No preamble, no quotes, no notes.
- Keep it the same length and tone — this is a short listing blurb, not prose.
- Keep proper nouns (neighbourhoods, cities like Lomé, Noèpé) exactly as written.
- Do NOT convert or reword prices, measurements, or numbers.
- Use this vocabulary for consistency with the rest of the app:
${GLOSSARY}`,
            messages: [{ role: 'user', content: frenchText }],
        });

        const translated = response.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        return translated || null;
    } catch (error) {
        console.error('translateToEnglish failed:', error.message);
        return null;
    }
};

// ── translateToFrench(englishText) ──
// The reverse direction — needed because the dashboard's "Add property" form
// lets an admin type the description in either language; whichever one they
// DIDN'T type has to come from somewhere. Same never-throws/null-on-failure
// contract as translateToEnglish.
const translateToFrench = async (englishText) => {
    if (!englishText || !englishText.trim()) return null;

    try {
        const response = await anthropic.messages.create({
            model: TRANSLATION_MODEL,
            max_tokens: 500,
            temperature: 0,
            system: `You translate English real-estate listing descriptions (Togo market) into natural French.

Rules:
- Output ONLY the translated sentence. No preamble, no quotes, no notes.
- Keep it the same length and tone — this is a short listing blurb, not prose.
- Keep proper nouns (neighbourhoods, cities like Lomé, Noèpé) exactly as written.
- Do NOT convert or reword prices, measurements, or numbers.
- Use this vocabulary for consistency with the rest of the app (reversed — translate INTO the French term on the left):
${GLOSSARY}`,
            messages: [{ role: 'user', content: englishText }],
        });

        const translated = response.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        return translated || null;
    } catch (error) {
        console.error('translateToFrench failed:', error.message);
        return null;
    }
};

module.exports = { translateToEnglish, translateToFrench };
