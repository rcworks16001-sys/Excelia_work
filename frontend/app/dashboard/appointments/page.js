'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '../../../lib/api';
import { useDashboardLanguage } from '../../../lib/useDashboardLanguage';
import { dashboardStrings } from '../../../lib/dashboardStrings';

const formatDate = (date) => {
    if (!date) return '—';
    return new Date(date).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
};

const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
};

const STATUS_COLORS = {
    pending: { bg: 'var(--yellow)', color: 'var(--ink)' },
    confirmed: { bg: 'var(--green)', color: 'var(--ink)' },
    cancelled: { bg: 'var(--mist)', color: 'var(--fog)' },
    completed: { bg: 'var(--ink)', color: '#fff' },
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

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 24 }}>
                {t.subtitle}
            </p>

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

                {!loading && appointments.length === 0 && (
                    <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                        <div style={{ fontSize: 32, marginBottom: 10 }}>📅</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t.emptyTitle}</div>
                        <p style={{ fontSize: 13, color: 'var(--fog)' }}>
                            {t.emptyHint}
                        </p>
                    </div>
                )}

                {!loading && appointments.map((appt, i) => (
                    <div key={appt.id} style={{
                        display: 'grid', gridTemplateColumns: '1.6fr 1.8fr 1.6fr 1fr 1.2fr',
                        padding: '15px 20px', alignItems: 'center',
                        borderBottom: i < appointments.length - 1 ? '1px solid var(--ice)' : 'none',
                    }}>
                        <div>
                            <Link href={`/dashboard/leads/${appt.lead_id}`} style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', textDecoration: 'none' }}>
                                {appt.lead_name || t.unknownName}
                            </Link>
                            <div style={{ fontSize: 11, color: 'var(--fog)', fontFamily: 'monospace' }}>{appt.lead_phone}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>
                                {appt.type} — {appt.neighbourhood}, {appt.city}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--fog)' }}>{formatXOF(appt.price)}</div>
                        </div>
                        <div>
                            <div style={{ fontSize: 12 }}>{appt.requested_datetime_text}</div>
                            {appt.requested_datetime && (
                                <div style={{ fontSize: 11, color: 'var(--fog)' }}>{formatDate(appt.requested_datetime)}</div>
                            )}
                        </div>
                        <span className="badge" style={{
                            background: STATUS_COLORS[appt.status]?.bg || 'var(--mist)',
                            color: STATUS_COLORS[appt.status]?.color || 'var(--ash)',
                            width: 'fit-content',
                        }}>
                            {appt.status}
                        </span>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{formatDate(appt.created_at)}</div>
                    </div>
                ))}
            </div>
        </div>
    );
}
