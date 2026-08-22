const Anthropic = require('@anthropic-ai/sdk');

// Generates a short admin-facing summary of a lead's WhatsApp conversation, on
// demand from the dashboard's "Summarize" button. Deliberately NOT cached: the
// conversation keeps growing, so a stored summary would go stale after the
// very next message. One Claude call per click is the accepted cost for that
// — same reasoning as reply-to-lead being local-only, just for a read instead
// of a write.
//
// This is an admin-reading tool, not a bot reply — it summarizes in whichever
// language the ADMIN's dashboard toggle is set to, independent of the lead's
// own stored language (see CLAUDE.md: dashboard language toggle vs bot
// language — this is the one exception where the dashboard toggle DOES touch
// something conversation-derived, because the output here is for the admin's
// eyes only and is never sent to the lead or persisted).
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

const buildTranscript = (messages) =>
    messages.map((m) => `${m.sender === 'bot' ? 'Agent' : 'Lead'}: ${m.message}`).join('\n');

const INSTRUCTIONS = {
    en: `Summarize this WhatsApp conversation between a real estate lead and the agency's bot, for an admin who is about to call the lead. In English.
Cover, in 3-5 short sentences: what the lead is looking for, key facts already established (budget, location, type, timeline), what's still outstanding, and any friction (objections, rejected listings, requests for a human). Do not invent anything not present in the transcript. Output plain text only, no headings, no bullet list markers.`,
    fr: `Résume cette conversation WhatsApp entre un prospect immobilier et le bot de l'agence, pour un admin qui va rappeler ce prospect. En français.
Couvre, en 3 à 5 phrases courtes : ce que recherche le prospect, les faits déjà établis (budget, lieu, type, échéance), ce qui reste à clarifier, et toute friction (objections, biens refusés, demande d'un conseiller humain). N'invente rien qui ne soit pas dans la transcription. Réponds en texte brut uniquement, sans titres ni puces.`,
};

// ── summarizeConversation(messages, lang) ──
// messages: [{ sender, message }] in chronological order.
// Returns a short plain-text summary, or null on failure (never throws — the
// dashboard button shows an error message instead of breaking the page).
const summarizeConversation = async (messages, lang = 'fr') => {
    if (!messages || messages.length === 0) return null;

    const transcript = buildTranscript(messages);

    try {
        const response = await anthropic.messages.create({
            model: SUMMARY_MODEL,
            max_tokens: 400,
            temperature: 0,
            system: INSTRUCTIONS[lang] || INSTRUCTIONS.fr,
            messages: [{ role: 'user', content: transcript }],
        });

        const summary = response.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
            .trim();

        return summary || null;
    } catch (error) {
        console.error('summarizeConversation failed:', error.message);
        return null;
    }
};

module.exports = { summarizeConversation };
