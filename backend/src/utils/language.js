const Anthropic = require('@anthropic-ai/sdk');
// The SDK's zodOutputFormat helper expects schemas built with zod's v4 API
// shape — the top-level `zod` export in this installed version (3.25.x) is
// still the classic v3-shaped API, so schemas must come from 'zod/v4'.
const { z } = require('zod/v4');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const NLU_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_LANGUAGE = 'fr'; // Togo is Francophone — safe default if detection fails

const LanguageSchema = z.object({ language: z.enum(['fr', 'en']) });

// ── detectLanguage(text) ──
// The ONE place language detection happens. Import this everywhere else that
// needs to know French vs English — never repeat this call.
const detectLanguage = async (text) => {
    if (!text || !text.trim()) return DEFAULT_LANGUAGE;
    try {
        const response = await anthropic.messages.parse({
            model: NLU_MODEL,
            max_tokens: 256,
            temperature: 0,
            system: 'Detect whether the following WhatsApp message is written in French or English. If mixed or ambiguous, pick the dominant language.',
            messages: [{ role: 'user', content: text }],
            output_config: { format: zodOutputFormat(LanguageSchema) },
        });
        return response.parsed_output?.language ?? DEFAULT_LANGUAGE;
    } catch (error) {
        console.error('detectLanguage failed, defaulting to fr:', error.message);
        return DEFAULT_LANGUAGE;
    }
};

// ── detectLanguageSwitchRequest(text) ──
// Did the lead explicitly ASK to be spoken to in another language?
//
// Deliberately regex, not an LLM call: these requests are highly formulaic,
// and this has to work on messages as short as "english" — which are exactly
// the ones detectLanguage() is (correctly) not trusted with. Zero latency,
// zero cost, deterministic, and it runs on every message including mid-booking.
//
// Returns 'fr' | 'en' | null.
const LANGUAGE_SWITCH_PATTERNS = [
    // "in english", "en anglais", "english please", "speak/reply/write in english"
    { lang: 'en', re: /\b(?:in|en)\s+(?:english|anglais)\b/i },
    { lang: 'en', re: /\b(?:english|anglais)\s*(?:please|pls|svp|s'?il\s+vous\s+pla[iî]t)\b/i },
    { lang: 'en', re: /\b(?:speak|spoke|parle[rz]?|r[ée]pon(?:ds?|dre|dez)|reply|answer|write|[ée]cri(?:s|re|vez)|switch|change|continue)\b[^.?!]{0,25}\b(?:english|anglais)\b/i },
    { lang: 'en', re: /^\s*(?:english|anglais)\s*[!.?]*\s*$/i },

    { lang: 'fr', re: /\b(?:in|en)\s+(?:french|fran[cç]ais)\b/i },
    { lang: 'fr', re: /\b(?:french|fran[cç]ais)\s*(?:please|pls|svp|s'?il\s+vous\s+pla[iî]t)\b/i },
    { lang: 'fr', re: /\b(?:speak|spoke|parle[rz]?|r[ée]pon(?:ds?|dre|dez)|reply|answer|write|[ée]cri(?:s|re|vez)|switch|change|continue)\b[^.?!]{0,25}\b(?:french|fran[cç]ais)\b/i },
    { lang: 'fr', re: /^\s*(?:french|fran[cç]ais)\s*[!.?]*\s*$/i },
];

const detectLanguageSwitchRequest = (text) => {
    if (!text || !text.trim()) return null;
    for (const { lang, re } of LANGUAGE_SWITCH_PATTERNS) {
        if (re.test(text)) return lang;
    }
    return null;
};

// ── BOT_STRINGS ──
// Hardcoded bilingual bot strings. One object, two keys (fr/en) per message.
// Never ask Claude to translate these.
const BOT_STRINGS = {
    // Short opener prefixed to the FIRST reply ever sent to a brand-new
    // lead, when that reply is something other than welcome_clarify (which
    // is already a full welcome on its own — see handleMessage).
    welcome_prefix: {
        fr: "Bonjour 👋 Bienvenue chez EXCELIA, votre assistant immobilier au Togo !",
        en: "Hello 👋 Welcome to EXCELIA, your real estate assistant in Togo!",
    },
    welcome_clarify: {
        fr: "Bonjour ! Je suis EXCELIA, votre assistant immobilier. Dites-moi ce que vous recherchez : ville ou quartier, type de bien (chambre salon, appartement, villa, terrain, mini-villa, appartement meublé), budget, nombre de chambres.",
        en: "Hello! I'm EXCELIA, your real estate assistant. Tell me what you're looking for: city or neighbourhood, property type (single room, apartment, villa, land, mini-villa, furnished apartment), budget, number of bedrooms.",
    },
    off_topic: {
        fr: "Je suis spécialisé dans la recherche immobilière au Togo. Dites-moi ce que vous recherchez comme logement et je vous aiderai avec plaisir.",
        en: "I'm specialized in real estate search in Togo. Tell me what kind of property you're looking for and I'll be happy to help.",
    },
    no_results: {
        fr: "Je n'ai trouvé aucun bien correspondant pour le moment. Pouvez-vous préciser la ville, le type de bien ou votre budget ?",
        en: "I couldn't find any matching properties right now. Could you tell me more about the city, property type, or your budget?",
    },
    results_intro: {
        fr: "Voici ce que j'ai trouvé pour vous :",
        en: "Here's what I found for you:",
    },
    unsupported_message_type: {
        fr: "Je ne peux lire que des messages texte pour le moment. Pouvez-vous décrire ce que vous recherchez par écrit ?",
        en: "I can only read text messages for now. Could you describe what you're looking for in writing?",
    },
    error_fallback: {
        fr: "Désolé, une erreur est survenue. Pouvez-vous reformuler votre demande ?",
        en: "Sorry, something went wrong. Could you try rephrasing your request?",
    },
    booking_prompt: {
        fr: "Souhaitez-vous réserver une visite ? Répondez avec le numéro du bien qui vous intéresse, ou « non » si ce n'est pas le cas.",
        en: "Would you like to book a viewing? Reply with the number of the property you're interested in, or 'no' if you're not.",
    },
    booking_declined: {
        fr: "Pas de souci ! N'hésitez pas à me recontacter si vous changez d'avis ou cherchez autre chose.",
        en: "No problem! Feel free to reach out again if you change your mind or are looking for something else.",
    },
    booking_selection_unclear: {
        fr: "Je n'ai pas compris votre choix. Répondez avec le numéro du bien qui vous intéresse (par exemple « 1 »), ou « non ».",
        en: "I didn't quite catch that. Reply with the number of the property you're interested in (e.g. '1'), or 'no'.",
    },
    ask_datetime: {
        fr: "Parfait ! Quelle date et heure vous conviendraient pour la visite ?",
        en: "Great! What date and time would work for the viewing?",
    },
    booking_confirmed: {
        fr: "C'est noté ! Votre demande de visite a été enregistrée pour :",
        en: "Got it! Your viewing request has been saved for:",
    },
    closing: {
        fr: "Avec plaisir ! N'hésitez pas à m'écrire si vous avez besoin d'autre chose.",
        en: "You're welcome! Feel free to message me any time if you need anything else.",
    },
    language_switched: {
        fr: "Bien sûr, je continue en français. Que recherchez-vous ?",
        en: "Of course, I'll continue in English. What are you looking for?",
    },
};

// Bilingual display labels for the property `type` enum — used when
// formatting listing summaries sent back to the user.
const PROPERTY_TYPE_LABELS = {
    chambre_salon: { fr: 'Chambre salon', en: 'Single room' },
    appartement: { fr: 'Appartement', en: 'Apartment' },
    villa: { fr: 'Villa', en: 'Villa' },
    terrain: { fr: 'Terrain', en: 'Land' },
    mini_villa: { fr: 'Mini-villa', en: 'Mini-villa' },
    appartement_meuble: { fr: 'Appartement meublé', en: 'Furnished apartment' },
};

module.exports = {
    detectLanguage,
    detectLanguageSwitchRequest,
    BOT_STRINGS,
    PROPERTY_TYPE_LABELS,
    DEFAULT_LANGUAGE,
};
