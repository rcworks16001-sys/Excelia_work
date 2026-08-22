'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../../../lib/api';
import { useDashboardLanguage } from '../../../lib/useDashboardLanguage';
import { dashboardStrings, propertyTypeLabels } from '../../../lib/dashboardStrings';
import { TEMPERATURE_CONFIG, LEAD_TEMPERATURES } from '../../../lib/statusConfig';

const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
};

const formatDate = (iso, lang) =>
    new Date(iso).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    });

// Turns a stored SEARCH_RETURNED_NOTHING filter blob back into something an
// agent can read — this is a list of demand the catalogue couldn't serve, so
// it has to be legible at a glance to be worth anything.
const describeFilters = (filters, lang) => {
    if (!filters) return '—';
    const t = propertyTypeLabels[lang];
    const parts = [
        filters.type ? t[filters.type] || filters.type : null,
        filters.bedrooms_min ? `${filters.bedrooms_min}${filters.bedrooms_max && filters.bedrooms_max !== filters.bedrooms_min ? `-${filters.bedrooms_max}` : ''} ${lang === 'fr' ? 'ch.' : 'bd'}` : null,
        filters.neighbourhood || filters.city || null,
        (filters.price_ceiling || filters.price_max) ? `≤ ${formatXOF(filters.price_ceiling || filters.price_max)}` : null,
        filters.transaction ? (filters.transaction === 'sale' ? (lang === 'fr' ? 'à vendre' : 'for sale') : (lang === 'fr' ? 'à louer' : 'to rent')) : null,
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
};

function Card({ title, hint, children }) {
    return (
        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', padding: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 2 }}>{title}</div>
            {hint && <div style={{ fontSize: 11, color: 'var(--fog)', marginBottom: 12 }}>{hint}</div>}
            {children}
        </div>
    );
}

export default function AnalyticsPage() {
    const router = useRouter();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [lang] = useDashboardLanguage();
    const t = dashboardStrings[lang].analytics;

    useEffect(() => {
        (async () => {
            try {
                const response = await api.get('/analytics');
                setData(response.data);
            } catch (err) {
                if (err.response?.status === 401) { router.push('/login'); return; }
                setError(t.loadError);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (error) return <div style={{ color: '#b91c1c', fontSize: 13 }}>{error}</div>;
    if (!data) return <div style={{ fontSize: 13, color: 'var(--fog)' }}>{t.loading}</div>;

    const byTemp = Object.fromEntries(data.temperature.map((r) => [r.temperature, r.count]));
    const totalLeads = data.temperature.reduce((sum, r) => sum + r.count, 0);

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 24 }}>{t.subtitle}</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 16 }}>
                <Card title={t.temperature}>
                    {LEAD_TEMPERATURES.map((temp) => {
                        const count = byTemp[temp] || 0;
                        const pct = totalLeads ? Math.round((count / totalLeads) * 100) : 0;
                        const cfg = TEMPERATURE_CONFIG[temp];
                        return (
                            <div key={temp} style={{ marginBottom: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                                    <span style={{ fontWeight: 600, color: 'var(--ash)' }}>{cfg.label[lang]}</span>
                                    <span style={{ fontWeight: 800 }}>{count}</span>
                                </div>
                                {/* A bar, not a chart library — one dependency-free
                                    div communicates a proportion perfectly well. */}
                                <div style={{ height: 6, background: 'var(--mist)', borderRadius: 3, overflow: 'hidden' }}>
                                    <div style={{ width: `${pct}%`, height: '100%', background: cfg.color }} />
                                </div>
                            </div>
                        );
                    })}
                </Card>

                <Card title={t.conversion} hint={t.conversionHint(data.conversion.shown, data.conversion.booked)}>
                    <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1 }}>{data.conversion.rate}%</div>
                </Card>

                <Card title={t.handoffs} hint={t.handoffsHint}>
                    <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1 }}>{data.handoffsThisWeek}</div>
                </Card>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
                <Card title={t.deadSearches} hint={t.deadSearchesHint}>
                    {data.deadSearches.length === 0 && (
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{t.deadSearchesEmpty}</div>
                    )}
                    {data.deadSearches.map((s, i) => (
                        <div key={i} style={{ padding: '7px 0', borderBottom: i < data.deadSearches.length - 1 ? '1px solid var(--ice)' : 'none' }}>
                            <div style={{ fontSize: 12, fontWeight: 600 }}>{describeFilters(s.metadata?.filters, lang)}</div>
                            <div style={{ fontSize: 10, color: 'var(--fog)', marginTop: 2 }}>
                                {s.name || s.phone} · {formatDate(s.created_at, lang)}
                            </div>
                        </div>
                    ))}
                </Card>

                <Card title={t.mostRejected} hint={t.mostRejectedHint}>
                    {data.mostRejected.length === 0 && (
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{t.mostRejectedEmpty}</div>
                    )}
                    {data.mostRejected.map((p, i) => (
                        <div key={p.id} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '7px 0', borderBottom: i < data.mostRejected.length - 1 ? '1px solid var(--ice)' : 'none',
                        }}>
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>
                                    {propertyTypeLabels[lang][p.type] || p.type} — {p.neighbourhood}
                                </div>
                                <div style={{ fontSize: 10, color: 'var(--fog)' }}>{formatXOF(p.price)}</div>
                            </div>
                            <span style={{
                                fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999,
                                background: '#fee2e2', color: '#b91c1c', whiteSpace: 'nowrap',
                            }}>
                                {p.rejections} {t.rejections}
                            </span>
                        </div>
                    ))}
                </Card>
            </div>
        </div>
    );
}
