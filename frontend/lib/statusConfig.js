// Prospect pipeline stages — mirrors the CHECK constraint on leads.status in
// backend/src/db/migrate.js and VALID_STATUSES in leadController.js. Shared
// by the leads overview and lead detail pages so labels/colors stay in sync.
export const STATUSES = ['new', 'contacted', 'qualified', 'site_visit', 'converted', 'lost'];

// label is bilingual ({fr, en}) so it follows the dashboard language toggle —
// pass the current lang when reading it, e.g. STATUS_CONFIG[status].label[lang].
export const STATUS_CONFIG = {
    new: { label: { fr: 'Nouveau', en: 'New' }, bg: 'var(--yellow)', color: 'var(--ink)' },
    contacted: { label: { fr: 'Contacté', en: 'Contacted' }, bg: 'var(--mist)', color: 'var(--ash)' },
    qualified: { label: { fr: 'Qualifié', en: 'Qualified' }, bg: 'var(--green)', color: 'var(--ink)' },
    site_visit: { label: { fr: '🏠 Visite', en: '🏠 Site Visit' }, bg: 'var(--green)', color: 'var(--ink)' },
    converted: { label: { fr: '✓ Converti', en: '✓ Converted' }, bg: 'var(--ink)', color: '#fff' },
    lost: { label: { fr: 'Perdu', en: 'Lost' }, bg: 'var(--mist)', color: 'var(--fog)' },
};
