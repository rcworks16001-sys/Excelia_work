// ── The knowledge layer ──
//
// Questions about how renting and buying actually WORK in Togo — "what's a
// cour commune?", "what's a titre foncier?", "how much deposit will I need?".
//
// Before this, these were classified as off_topic and deflected: a lead asking
// a perfectly sensible property question was told "I'm specialized in real
// estate search". That is the opposite of helpful, and it is the doc's §30
// point exactly — sometimes the right next action is simply to ANSWER, not to
// steer every exchange back toward a booking.
//
// WHY A CURATED FILE AND NOT THE MODEL'S OWN KNOWLEDGE: everything here is
// verifiable, local, and agreed. Left to itself the model would happily invent
// a deposit norm or a legal requirement — plausible, fluent, and wrong, about
// money and law, in a market it knows little about. The composer is given ONLY
// the matching entries and told to answer from them or admit it doesn't know.
//
// WHY NOT A DB TABLE: this is agency-wide reference material that changes when
// the market changes, not per-listing data. A file is version-controlled,
// reviewable in a diff, and needs no admin UI. Move it to a table if the client
// ever wants to edit it themselves.
//
// Keep every entry factual and general. Nothing here may state a price, a
// commission, or a legal guarantee specific to a listing or a transaction —
// those belong to a human (see the wants_human escalation path).

const KNOWLEDGE = [
    {
        id: 'cour_commune',
        keywords: ['cour commune', 'cour-commune', 'shared courtyard', 'compound', 'courtyard'],
        fr: "Une cour commune est un ensemble de logements indépendants partageant une cour, et souvent les points d'eau et les sanitaires. C'est la formule la plus courante et la plus abordable au Togo. Chaque logement se loue séparément.",
        en: "A 'cour commune' is a group of independent dwellings sharing a courtyard, and often the water points and toilets. It is the most common and most affordable arrangement in Togo. Each dwelling is rented separately.",
    },
    {
        id: 'chambre_salon',
        keywords: ['chambre salon', 'chambre-salon', 'single room', 'what is a studio', "c'est quoi une chambre salon"],
        fr: "Une chambre salon, c'est un logement d'une chambre avec un salon séparé — l'équivalent local d'un studio une pièce. C'est le format le plus demandé pour une personne seule ou un jeune couple.",
        en: "A 'chambre salon' is a one-bedroom home with a separate living room — the local equivalent of a one-bedroom flat. It is the most sought-after format for a single person or a young couple.",
    },
    {
        id: 'titre_foncier',
        keywords: ['titre foncier', 'land title', 'title deed', 'papers', 'papiers', 'acte de vente', 'ownership document'],
        fr: "Le titre foncier est le document officiel de propriété d'un terrain au Togo — c'est la preuve la plus solide. Certains terrains se vendent avec d'autres documents (acte de vente, attestation), qui n'offrent pas la même sécurité. Vérifiez toujours ce qui accompagne un terrain avant d'acheter.",
        en: "A 'titre foncier' (land title) is the official ownership document for land in Togo — the strongest form of proof. Some plots are sold with other paperwork (a deed of sale, an attestation) which does not offer the same security. Always check which documents come with a plot before buying.",
    },
    {
        id: 'lease_terms',
        keywords: ['lease', 'contract', 'bail', 'contrat', 'how long', 'durée', 'caution', 'deposit', 'avance', 'advance'],
        fr: "Au Togo, une location résidentielle demande généralement une avance de plusieurs mois de loyer plus une caution. Le nombre de mois varie selon le propriétaire et le bien — l'agence vous confirmera les conditions exactes pour le logement qui vous intéresse.",
        en: "In Togo a residential rental usually requires several months' rent in advance plus a security deposit. The number of months varies by landlord and property — the agency will confirm the exact terms for the specific home you're interested in.",
    },
    {
        id: 'viewing_process',
        keywords: ['visit', 'viewing', 'visite', 'see the property', 'voir le bien', 'how does it work', 'comment ça marche'],
        fr: "Vous choisissez le bien qui vous intéresse, on note votre disponibilité, et un conseiller EXCELIA vous accompagne sur place pour la visite. La visite ne vous engage à rien.",
        en: "You pick the property you're interested in, we note when you're free, and an EXCELIA advisor takes you to see it in person. A viewing commits you to nothing.",
    },
    {
        id: 'furnished',
        keywords: ['furnished', 'meublé', 'meuble', 'equipped', 'équipé'],
        fr: "Un appartement meublé est livré avec les meubles et l'électroménager de base, prêt à habiter. Il se loue plus cher qu'un logement vide, mais souvent avec plus de souplesse sur la durée — pratique pour un séjour de courte durée.",
        en: "A furnished apartment comes with furniture and basic appliances, ready to move into. It rents for more than an unfurnished home, but often with more flexibility on the length of stay — useful for a shorter stay.",
    },
    {
        id: 'areas',
        keywords: ['which area', 'best neighbourhood', 'quel quartier', 'where should i live', 'safe area', 'quartier sûr'],
        fr: "Les quartiers de Lomé ont chacun leur caractère : le centre (Tokoin, Kodjoviakopé) est proche de tout, Adidogomé et Avédji sont résidentiels et plus abordables, Baguida et Bè sont proches de la mer, Agoè-Nyivé est en pleine expansion. Dites-moi ce qui compte le plus pour vous et je vous montrerai ce qui existe.",
        en: "Each Lomé neighbourhood has its own character: the centre (Tokoin, Kodjoviakopé) is close to everything, Adidogomé and Avédji are residential and more affordable, Baguida and Bè are near the sea, Agoè-Nyivé is growing fast. Tell me what matters most to you and I'll show you what's available.",
    },
];

// ── findKnowledge(text) ──
// Cheap keyword lookup, deliberately not a semantic search: at seven entries an
// embedding index would be more machinery than content. Returns every match so
// a question spanning two topics gets both.
const findKnowledge = (text) => {
    if (!text) return [];
    const haystack = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return KNOWLEDGE.filter((entry) =>
        entry.keywords.some((k) => haystack.includes(k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')))
    );
};

// ── knowledgeBlock(entries, lang) ──
// Renders matches for the composer prompt. Empty string when nothing matched,
// which is the signal to admit ignorance rather than improvise.
const knowledgeBlock = (entries, lang) => {
    if (!entries || entries.length === 0) return '';
    return entries.map((e) => `- ${e[lang] || e.fr}`).join('\n');
};

module.exports = { KNOWLEDGE, findKnowledge, knowledgeBlock };
