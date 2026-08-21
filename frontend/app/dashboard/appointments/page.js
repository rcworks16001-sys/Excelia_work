'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '../../../lib/api';
import { APPOINTMENT_STATUS_CONFIG } from '../../../lib/statusConfig';
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
    const [lang] = useDashboardLanguage();
    const t = dashboardStrings[lang].appointments;

    useEffect(() => {
        (async () => {
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
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const filteredAppointments = appointments.filter((appt) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (appt.lead_name || '').toLowerCase().includes(q)
            || (appt.lead_phone || '').toLowerCase().includes(q)
            || (appt.neighbourhood || '').toLowerCase().includes(q)
            || (appt.city || '').toLowerCase().includes(q);
    });

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 24 }}>
                {t.subtitle}
            </p>

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
                            {search ? t.emptyFilterHint : t.emptyHint}
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
                        <span className="badge" style={{
                            background: APPOINTMENT_STATUS_CONFIG[appt.status]?.bg || 'var(--mist)',
                            color: APPOINTMENT_STATUS_CONFIG[appt.status]?.color || 'var(--ash)',
                            width: 'fit-content',
                        }}>
                            {APPOINTMENT_STATUS_CONFIG[appt.status]?.label[lang] || appt.status}
                        </span>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{formatDate(appt.created_at, lang)}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}
