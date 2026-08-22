'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../../lib/api';
import { STATUSES, STATUS_CONFIG, TEMPERATURE_CONFIG } from '../../lib/statusConfig';
import { useDashboardLanguage } from '../../lib/useDashboardLanguage';
import { dashboardStrings, formatTimeAgo } from '../../lib/dashboardStrings';

const LANGUAGE_LABEL = { fr: 'FR', en: 'EN' };
const GRID_COLUMNS = '1.8fr 1.3fr 0.7fr 1.2fr 1.1fr 1.1fr';

function SkeletonRow() {
    return (
        <div style={{
            display: 'grid', gridTemplateColumns: GRID_COLUMNS,
            padding: '15px 20px', borderBottom: '1px solid var(--ice)', alignItems: 'center', gap: 8,
        }}>
            {[['60%', 12], ['70%', 10], ['30%', 18], ['50%', 18], ['50%', 10], ['50%', 10]].map(([w, h], i) => (
                <div key={i} className="skeleton" style={{ height: h, width: w }} />
            ))}
        </div>
    );
}

export default function LeadsOverviewPage() {
    const router = useRouter();
    const [leads, setLeads] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [statusUpdateError, setStatusUpdateError] = useState('');
    const [lang] = useDashboardLanguage();
    const t = dashboardStrings[lang].leadsOverview;

    useEffect(() => {
        fetchLeads();
    }, []);

    const fetchLeads = async () => {
        try {
            const response = await api.get('/leads');
            setLeads(response.data.leads);
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

    const handleStatusChange = async (leadId, newStatus) => {
        const previous = leads.find((l) => l.id === leadId)?.status;
        setStatusUpdateError('');
        setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: newStatus } : l))); // optimistic
        try {
            await api.patch(`/leads/${leadId}/status`, { status: newStatus });
        } catch (err) {
            setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: previous } : l))); // revert
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            setStatusUpdateError(t.statusUpdateError);
        }
    };

    const filteredLeads = leads.filter((lead) => {
        if (statusFilter !== 'all' && lead.status !== statusFilter) return false;
        if (!search) return true;
        // Match every word in the query against the combined name+phone, not
        // the whole query against one field — otherwise a copy-pasted "Name,
        // phone"-style string never matches (see the same fix on Properties).
        const haystack = `${lead.name || ''} ${lead.phone || ''}`.toLowerCase();
        const words = search.toLowerCase().replace(/[,.;]/g, ' ').split(/\s+/).filter(Boolean);
        return words.every((w) => haystack.includes(w));
    });

    const now = Date.now();
    const todayCount = leads.filter((l) => now - new Date(l.created_at).getTime() < 24 * 60 * 60 * 1000).length;
    const weekCount = leads.filter((l) => now - new Date(l.created_at).getTime() < 7 * 24 * 60 * 60 * 1000).length;

    const stats = [
        { label: t.statTotal, value: leads.length },
        { label: t.statToday, value: todayCount },
        { label: t.statWeek, value: weekCount },
    ];

    const countFor = (status) => leads.filter((l) => l.status === status).length;

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 24 }}>
                {t.subtitle}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
                {stats.map((stat) => (
                    <div key={stat.label} style={{
                        background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', padding: '18px 20px',
                    }}>
                        <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: -1, marginBottom: 4 }}>
                            {loading ? '—' : stat.value}
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fog)' }}>{stat.label}</div>
                    </div>
                ))}
            </div>

            {/* Pipeline stage filter — also doubles as a count-per-stage summary */}
            <div style={{ display: 'flex', gap: 3, background: '#fff', border: '1px solid var(--ice)', borderRadius: 12, padding: 4, marginBottom: 16, flexWrap: 'wrap', width: 'fit-content' }}>
                <button
                    onClick={() => setStatusFilter('all')}
                    style={{
                        padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        background: statusFilter === 'all' ? 'var(--ink)' : 'transparent',
                        color: statusFilter === 'all' ? '#fff' : 'var(--ash)',
                    }}
                >
                    {t.all} ({leads.length})
                </button>
                {STATUSES.map((s) => (
                    <button
                        key={s}
                        onClick={() => setStatusFilter(s)}
                        style={{
                            padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            background: statusFilter === s ? 'var(--ink)' : 'transparent',
                            color: statusFilter === s ? '#fff' : 'var(--ash)',
                        }}
                    >
                        {STATUS_CONFIG[s].label[lang]} ({countFor(s)})
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
                    display: 'grid', gridTemplateColumns: GRID_COLUMNS,
                    padding: '12px 20px', background: 'var(--mist)', borderBottom: '1px solid var(--ice)',
                }}>
                    {[t.colName, t.colPhone, t.colLang, t.colStatus, t.colFirstContact, t.colLastMessage].map((h) => (
                        <div key={h} style={{ fontSize: 10, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            {h}
                        </div>
                    ))}
                </div>

                {loading && [1, 2, 3, 4].map((i) => <SkeletonRow key={i} />)}

                {!loading && filteredLeads.length === 0 && (
                    <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                        <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{t.emptyTitle}</div>
                        <p style={{ fontSize: 13, color: 'var(--fog)' }}>
                            {search || statusFilter !== 'all' ? t.emptyFilterHint : t.emptyDefaultHint}
                        </p>
                    </div>
                )}

                {!loading && filteredLeads.map((lead, i) => (
                    <div
                        key={lead.id}
                        onClick={() => router.push(`/dashboard/leads/${lead.id}`)}
                        style={{
                            display: 'grid', gridTemplateColumns: GRID_COLUMNS,
                            padding: '15px 20px', alignItems: 'center', cursor: 'pointer',
                            borderBottom: i < filteredLeads.length - 1 ? '1px solid var(--ice)' : 'none',
                        }}
                    >
                        <div style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {lead.name || t.unknownName}
                            {/* Only hot is marked. Badging every lead with its
                                band would just add colour to every row and
                                stop any of it meaning anything. */}
                            {lead.lead_temperature === 'hot' && (
                                <span style={{
                                    fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 999,
                                    background: TEMPERATURE_CONFIG.hot.bg, color: TEMPERATURE_CONFIG.hot.color,
                                }} title={`${t.scoreLabel}: ${lead.lead_score}/100`}>
                                    {TEMPERATURE_CONFIG.hot.label[lang]}
                                </span>
                            )}
                            {lead.needs_human && (
                                <span style={{
                                    fontSize: 9, fontWeight: 800, padding: '2px 6px', borderRadius: 999,
                                    background: '#fef3c7', color: '#92400e',
                                }}>
                                    {t.needsHumanBadge}
                                </span>
                            )}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--ash)', fontFamily: 'monospace' }}>{lead.phone}</div>
                        <span className="badge" style={{ background: 'var(--mist)', color: 'var(--ash)', width: 'fit-content' }}>
                            {LANGUAGE_LABEL[lead.language] || lead.language}
                        </span>
                        <select
                            value={lead.status}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => handleStatusChange(lead.id, e.target.value)}
                            className="badge"
                            style={{
                                background: STATUS_CONFIG[lead.status]?.bg || 'var(--mist)',
                                color: STATUS_CONFIG[lead.status]?.color || 'var(--ash)',
                                width: 'fit-content', border: 'none', cursor: 'pointer', fontWeight: 700,
                            }}
                        >
                            {STATUSES.map((s) => (
                                <option key={s} value={s}>{STATUS_CONFIG[s].label[lang]}</option>
                            ))}
                        </select>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{formatTimeAgo(lead.created_at, lang)}</div>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{formatTimeAgo(lead.last_message_at, lang)}</div>
                    </div>
                ))}
            </div>

            {!loading && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--fog)', textAlign: 'right' }}>
                    {filteredLeads.length} {t.countOf} {leads.length} {t.countLeads}
                </div>
            )}
        </div>
    );
}
