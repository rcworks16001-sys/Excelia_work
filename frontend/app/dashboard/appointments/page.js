'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '../../../lib/api';
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_CONFIG } from '../../../lib/statusConfig';
import { useDashboardLanguage } from '../../../lib/useDashboardLanguage';
import { dashboardStrings, propertyTypeLabels, timeOfDayLabels } from '../../../lib/dashboardStrings';

// Locale follows the dashboard toggle, so date/time text stays consistent
// with everything else on the page instead of always rendering English-style.
//
// timeZone is pinned to UTC because Togo is UTC+0 and these are viewings that
// physically happen there — without this, toLocaleString silently renders in
// whatever zone the ADMIN's browser is in, so a 15:00 Lomé viewing showed as
// 20:30 to someone in India. Appointment times must not move with the viewer.
const formatDate = (date, lang) => {
    if (!date) return '—';
    return new Date(date).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    });
};

// Date only — used when a lead gave a day but no exact clock time.
// Arrives as a bare "YYYY-MM-DD" string (the API deliberately sends text, not
// a timestamp). Pinning it to UTC midnight is what stops "2026-08-21" from
// being read as local midnight and then rendering as the 20th.
const formatDateOnly = (dateStr, lang) => {
    if (!dateStr) return '';
    return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
};

// What the lead asked for, best-precision-first:
//   exact datetime  -> "22 Aug 2026, 15:00"
//   date + day part -> "22 Aug 2026, morning"
//   date only       -> "22 Aug 2026"
//   nothing parsed  -> their raw words ("demain matin")
// The raw text is always the last resort so a booking never displays blank.
const formatRequested = (appt, lang) => {
    if (appt.requested_datetime) return formatDate(appt.requested_datetime, lang);
    if (appt.requested_date) {
        const day = formatDateOnly(appt.requested_date, lang);
        const part = timeOfDayLabels[lang][appt.requested_time_of_day];
        return part ? `${day}, ${part}` : day;
    }
    return appt.requested_datetime_text;
};

const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
};

function SkeletonRow() {
    return (
        <div style={{
            display: 'grid', gridTemplateColumns: '1.6fr 1.8fr 1.6fr 1fr 1.2fr',
            padding: '15px 20px', borderBottom: '1px solid var(--ice)', alignItems: 'center', gap: 8,
        }}>
            {[['60%', 12], ['70%', 10], ['50%', 10], ['40%', 18], ['50%', 10]].map(([w, h], i) => (
                <div key={i} className="skeleton" style={{ height: h, width: w }} />
            ))}
        </div>
    );
}

export default function AppointmentsPage() {
    const router = useRouter();
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [statusUpdateError, setStatusUpdateError] = useState('');
    const [lang] = useDashboardLanguage();
    const t = dashboardStrings[lang].appointments;

    const fetchAppointments = async () => {
        try {
            const response = await api.get('/appointments');
            setAppointments(response.data.appointments);
        } catch (err) {
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            setError(t.loadError);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchAppointments();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleStatusChange = async (appointmentId, newStatus) => {
        const previous = appointments.find((a) => a.id === appointmentId)?.status;
        setStatusUpdateError('');
        setAppointments((prev) => prev.map((a) => (a.id === appointmentId ? { ...a, status: newStatus } : a))); // optimistic
        try {
            await api.patch(`/appointments/${appointmentId}/status`, { status: newStatus });
        } catch (err) {
            setAppointments((prev) => prev.map((a) => (a.id === appointmentId ? { ...a, status: previous } : a))); // revert
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            setStatusUpdateError(t.statusUpdateError);
        }
    };

    const filteredAppointments = appointments.filter((appt) => {
        if (statusFilter !== 'all' && appt.status !== statusFilter) return false;
        if (!search) return true;
        // Match every word in the query against the combined fields, not the
        // whole query against one field — a copy-pasted "Neighbourhood, City"
        // string otherwise never matches (see the same fix on Properties).
        const haystack = `${appt.lead_name || ''} ${appt.lead_phone || ''} ${appt.neighbourhood || ''} ${appt.city || ''}`.toLowerCase();
        const words = search.toLowerCase().replace(/[,.;]/g, ' ').split(/\s+/).filter(Boolean);
        return words.every((w) => haystack.includes(w));
    });

    const countFor = (status) => appointments.filter((a) => a.status === status).length;

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 24 }}>
                {t.subtitle}
            </p>

            {/* Status filter — also doubles as a count-per-status summary, mirrors the Leads page */}
            <div style={{ display: 'flex', gap: 3, background: '#fff', border: '1px solid var(--ice)', borderRadius: 12, padding: 4, marginBottom: 16, flexWrap: 'wrap', width: 'fit-content' }}>
                <button
                    onClick={() => setStatusFilter('all')}
                    style={{
                        padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        background: statusFilter === 'all' ? 'var(--ink)' : 'transparent',
                        color: statusFilter === 'all' ? '#fff' : 'var(--ash)',
                    }}
                >
                    {t.all} ({appointments.length})
                </button>
                {APPOINTMENT_STATUSES.map((s) => (
                    <button
                        key={s}
                        onClick={() => setStatusFilter(s)}
                        style={{
                            padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            background: statusFilter === s ? 'var(--ink)' : 'transparent',
                            color: statusFilter === s ? '#fff' : 'var(--ash)',
                        }}
                    >
                        {APPOINTMENT_STATUS_CONFIG[s].label[lang]} ({countFor(s)})
                    </button>
                ))}
            </div>

            <input
                type="text"
                placeholder={t.searchPlaceholder}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                    padding: '9px 14px', border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)',
                    fontSize: 13, outline: 'none', width: 260, marginBottom: 16, color: 'var(--ink)',
                }}
            />

            {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{error}</div>}
            {statusUpdateError && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{statusUpdateError}</div>}

            <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
                <div style={{
                    display: 'grid', gridTemplateColumns: '1.6fr 1.8fr 1.6fr 1fr 1.2fr',
                    padding: '12px 20px', background: 'var(--mist)', borderBottom: '1px solid var(--ice)',
                }}>
                    {[t.colLead, t.colProperty, t.colRequested, t.colStatus, t.colBooked].map((h) => (
                        <div key={h} style={{ fontSize: 10, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            {h}
                        </div>
                    ))}
                </div>

                {loading && [1, 2, 3].map((i) => <SkeletonRow key={i} />)}

                {!loading && filteredAppointments.length === 0 && (
                    <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                        <div style={{ fontSize: 32, marginBottom: 10 }}>📅</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t.emptyTitle}</div>
                        <p style={{ fontSize: 13, color: 'var(--fog)' }}>
                            {search || statusFilter !== 'all' ? t.emptyFilterHint : t.emptyHint}
                        </p>
                    </div>
                )}

                {!loading && filteredAppointments.map((appt, i) => (
                    <div key={appt.id} style={{
                        display: 'grid', gridTemplateColumns: '1.6fr 1.8fr 1.6fr 1fr 1.2fr',
                        padding: '15px 20px', alignItems: 'center',
                        borderBottom: i < filteredAppointments.length - 1 ? '1px solid var(--ice)' : 'none',
                    }}>
                        <div>
                            <Link href={`/dashboard/leads/${appt.lead_id}`} style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', textDecoration: 'none' }}>
                                {appt.lead_name || t.unknownName}
                            </Link>
                            <div style={{ fontSize: 11, color: 'var(--fog)', fontFamily: 'monospace' }}>{appt.lead_phone}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>
                                {propertyTypeLabels[lang][appt.type] || appt.type} — {appt.neighbourhood}, {appt.city}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--fog)' }}>{formatXOF(appt.price)}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12 }}>{formatRequested(appt, lang)}</div>
                        </div>
                        <select
                            value={appt.status}
                            onChange={(e) => handleStatusChange(appt.id, e.target.value)}
                            className="badge"
                            style={{
                                background: APPOINTMENT_STATUS_CONFIG[appt.status]?.bg || 'var(--mist)',
                                color: APPOINTMENT_STATUS_CONFIG[appt.status]?.color || 'var(--ash)',
                                width: 'fit-content', border: 'none', cursor: 'pointer', fontWeight: 700,
                            }}
                        >
                            {APPOINTMENT_STATUSES.map((s) => (
                                <option key={s} value={s}>{APPOINTMENT_STATUS_CONFIG[s].label[lang]}</option>
                            ))}
                        </select>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{formatDate(appt.created_at, lang)}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}
