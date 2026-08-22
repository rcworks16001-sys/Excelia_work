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

// Appointment (viewing request) statuses — mirrors the CHECK constraint on
// appointments.status in backend/src/db/migrate.js. Shared by the
// appointments list and the lead detail page so the FR/EN dashboard toggle
// actually translates these badges instead of showing the raw DB value.
export const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];

export const APPOINTMENT_STATUS_CONFIG = {
    pending: { label: { fr: 'En attente', en: 'Pending' }, bg: 'var(--yellow)', color: 'var(--ink)' },
    confirmed: { label: { fr: 'Confirmé', en: 'Confirmed' }, bg: 'var(--green)', color: 'var(--ink)' },
    cancelled: { label: { fr: 'Annulé', en: 'Cancelled' }, bg: 'var(--mist)', color: 'var(--fog)' },
    completed: { label: { fr: 'Terminé', en: 'Completed' }, bg: 'var(--ink)', color: '#fff' },
};

// Listing availability — mirrors the CHECK constraint on properties.listing_status
// in backend/src/db/migrate.js. Shared by the Properties page badge + status
// dropdown. No --red token exists in globals.css; the rest of this codebase
// uses the raw #b91c1c red directly for destructive/warning states (delete
// buttons, error text), so "Rented" follows that same convention here.
export const LISTING_STATUSES = ['available', 'reserved', 'rented'];

export const LISTING_STATUS_CONFIG = {
    available: { label: { fr: 'Disponible', en: 'Available' }, bg: 'var(--green)', color: 'var(--ink)' },
    reserved: { label: { fr: 'Réservé', en: 'Reserved' }, bg: 'var(--yellow)', color: 'var(--ink)' },
    rented: { label: { fr: 'Loué', en: 'Rented' }, bg: '#fef2f2', color: '#b91c1c' },
};
