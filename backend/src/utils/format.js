// ── formatXOF(amount) ──
// The ONE place XOF price formatting happens. Prices are stored as raw
// integers in the DB — never store as string, format on display only.
// Manual thousands-separator (not toLocaleString) so this doesn't depend on
// which ICU data Node was built with.
const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    const sign = n < 0 ? '-' : '';
    const digits = Math.abs(n).toString();
    const withSeparators = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${sign}${withSeparators} F CFA`;
};

// ── maskPhone(phone) ──
// The ONE place a WhatsApp number gets masked before leaving the backend.
// Per CLAUDE.md: "Never send a user's WhatsApp number to the frontend."
// Keeps the last 4 digits (useful for identifying a lead on a call list)
// and masks the rest.
const maskPhone = (phone) => {
    if (!phone) return '';
    const str = String(phone);
    if (str.length <= 4) return '*'.repeat(str.length);
    return '*'.repeat(str.length - 4) + str.slice(-4);
};

module.exports = { formatXOF, maskPhone };
