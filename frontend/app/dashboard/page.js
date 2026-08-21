'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../../lib/api';
import { STATUSES, STATUS_CONFIG } from '../../lib/statusConfig';

const timeAgo = (date) => {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);
    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
};

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
            setError('Failed to load leads.');
        } finally {
            setLoading(false);
        }
    };

    const filteredLeads = leads.filter((lead) => {
        if (statusFilter !== 'all' && lead.status !== statusFilter) return false;
        if (!search) return true;
        const q = search.toLowerCase();
        return (lead.name || '').toLowerCase().includes(q) || lead.phone.includes(q);
    });

    const now = Date.now();
    const todayCount = leads.filter((l) => now - new Date(l.created_at).getTime() < 24 * 60 * 60 * 1000).length;
    const weekCount = leads.filter((l) => now - new Date(l.created_at).getTime() < 7 * 24 * 60 * 60 * 1000).length;

    const stats = [
        { label: 'Total leads', value: leads.length },
        { label: 'New today', value: todayCount },
        { label: 'New this week', value: weekCount },
    ];

    const countFor = (status) => leads.filter((l) => l.status === status).length;

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>Leads</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 24 }}>
                Everyone who has contacted the WhatsApp bot
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
                    All ({leads.length})
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
                        {STATUS_CONFIG[s].label} ({countFor(s)})
                    </button>
                ))}
            </div>

            <input
                type="text"
                placeholder="Search by name or phone…"
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
                    display: 'grid', gridTemplateColumns: GRID_COLUMNS,
                    padding: '12px 20px', background: 'var(--mist)', borderBottom: '1px solid var(--ice)',
                }}>
                    {['Name', 'Phone', 'Lang', 'Status', 'First contact', 'Last message'].map((h) => (
                        <div key={h} style={{ fontSize: 10, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                            {h}
                        </div>
                    ))}
                </div>

                {loading && [1, 2, 3, 4].map((i) => <SkeletonRow key={i} />)}

                {!loading && filteredLeads.length === 0 && (
                    <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                        <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
                        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>No leads yet</div>
                        <p style={{ fontSize: 13, color: 'var(--fog)' }}>
                            {search || statusFilter !== 'all' ? 'Try a different search or filter.' : 'Leads appear here once the bot captures them.'}
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
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{lead.name || 'Unknown'}</div>
                        <div style={{ fontSize: 12, color: 'var(--ash)', fontFamily: 'monospace' }}>{lead.phone}</div>
                        <span className="badge" style={{ background: 'var(--mist)', color: 'var(--ash)', width: 'fit-content' }}>
                            {LANGUAGE_LABEL[lead.language] || lead.language}
                        </span>
                        <span className="badge" style={{
                            background: STATUS_CONFIG[lead.status]?.bg || 'var(--mist)',
                            color: STATUS_CONFIG[lead.status]?.color || 'var(--ash)',
                            width: 'fit-content',
                        }}>
                            {STATUS_CONFIG[lead.status]?.label || lead.status}
                        </span>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{timeAgo(lead.created_at)}</div>
                        <div style={{ fontSize: 12, color: 'var(--fog)' }}>{timeAgo(lead.last_message_at)}</div>
                    </div>
                ))}
            </div>

            {!loading && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--fog)', textAlign: 'right' }}>
                    {filteredLeads.length} of {leads.length} leads
                </div>
            )}
        </div>
    );
}
