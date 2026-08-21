// Prospect pipeline stages — mirrors the CHECK constraint on leads.status in
// backend/src/db/migrate.js and VALID_STATUSES in leadController.js. Shared
// by the leads overview and lead detail pages so labels/colors stay in sync.
export const STATUSES = ['new', 'contacted', 'qualified', 'site_visit', 'converted', 'lost'];

export const STATUS_CONFIG = {
    new: { label: 'New', bg: 'var(--yellow)', color: 'var(--ink)' },
    contacted: { label: 'Contacted', bg: 'var(--mist)', color: 'var(--ash)' },
    qualified: { label: 'Qualified', bg: 'var(--green)', color: 'var(--ink)' },
    site_visit: { label: '🏠 Site Visit', bg: 'var(--green)', color: 'var(--ink)' },
    converted: { label: '✓ Converted', bg: 'var(--ink)', color: '#fff' },
    lost: { label: 'Lost', bg: 'var(--mist)', color: 'var(--fog)' },
};
