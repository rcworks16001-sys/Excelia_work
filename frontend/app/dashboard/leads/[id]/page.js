'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import api from '../../../../lib/api';
import { STATUSES as LEAD_STATUSES, STATUS_CONFIG as LEAD_STATUS_CONFIG } from '../../../../lib/statusConfig';

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

// Chat-bubble alignment: user messages left, bot replies right.
const getSenderStyle = (sender) => ({
    alignSelf: sender === 'bot' ? 'flex-end' : 'flex-start',
    background: sender === 'bot' ? 'var(--ink)' : 'var(--mist)',
    color: sender === 'bot' ? '#fff' : 'var(--ink)',
});

export default function LeadDetailPage() {
    const router = useRouter();
    const params = useParams();
    const [lead, setLead] = useState(null);
    const [conversations, setConversations] = useState([]);
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [statusSaving, setStatusSaving] = useState(false);
    const [statusError, setStatusError] = useState('');

    useEffect(() => {
        fetchLead();
    }, [params.id]);

    const handleStatusChange = async (newStatus) => {
        const previous = lead.status;
        setStatusError('');
        setLead((l) => ({ ...l, status: newStatus })); // optimistic
        setStatusSaving(true);
        try {
            await api.patch(`/leads/${params.id}/status`, { status: newStatus });
        } catch (err) {
            setLead((l) => ({ ...l, status: previous })); // revert
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            setStatusError('Failed to update status.');
        } finally {
            setStatusSaving(false);
        }
    };

    const fetchLead = async () => {
        try {
            const response = await api.get(`/leads/${params.id}`);
            setLead(response.data.lead);
            setConversations(response.data.conversations);
            setAppointments(response.data.appointments);
        } catch (err) {
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            if (err.response?.status === 404) {
                setError('Lead not found.');
                return;
            }
            setError('Failed to load lead.');
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return <div style={{ fontSize: 13, color: 'var(--fog)' }}>Loading…</div>;
    }

    if (error) {
        return (
            <div>
                <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>{error}</div>
                <Link href="/dashboard" style={{ fontSize: 13, color: 'var(--ink)' }}>← Back to leads</Link>
            </div>
        );
    }

    return (
        <div>
            <Link href="/dashboard" style={{ fontSize: 12, color: 'var(--fog)', textDecoration: 'none' }}>← All leads</Link>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 26, fontWeight: 800 }}>{lead.name || 'Unknown'}</h1>
                <span className="badge" style={{ background: 'var(--mist)', color: 'var(--ash)' }}>
                    {(lead.language || '').toUpperCase()}
                </span>

                {/* Pipeline stage — the one place a lead's status is changed */}
                <select
                    value={lead.status}
                    onChange={(e) => handleStatusChange(e.target.value)}
                    disabled={statusSaving}
                    style={{
                        padding: '6px 10px', fontSize: 12, fontWeight: 700,
                        borderRadius: 'var(--r-btn)', border: '1px solid var(--ice)',
                        background: LEAD_STATUS_CONFIG[lead.status]?.bg || 'var(--mist)',
                        color: LEAD_STATUS_CONFIG[lead.status]?.color || 'var(--ash)',
                        cursor: statusSaving ? 'default' : 'pointer', outline: 'none',
                    }}
                >
                    {LEAD_STATUSES.map((s) => (
                        <option key={s} value={s}>{LEAD_STATUS_CONFIG[s].label}</option>
                    ))}
                </select>
                {statusSaving && <span style={{ fontSize: 11, color: 'var(--fog)' }}>Saving…</span>}
            </div>
            {statusError && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 8 }}>{statusError}</div>}
            <div style={{ fontSize: 13, color: 'var(--fog)', fontFamily: 'monospace', marginBottom: 4 }}>{lead.phone}</div>
            <div style={{ fontSize: 12, color: 'var(--fog)', marginBottom: 28 }}>
                First contact {formatDate(lead.created_at)} · Last message {formatDate(lead.last_message_at)}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 24 }}>
                {/* Conversation */}
                <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                        Conversation
                    </div>
                    <div style={{
                        background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                        padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 600, overflowY: 'auto',
                    }}>
                        {conversations.length === 0 && (
                            <div style={{ fontSize: 13, color: 'var(--fog)' }}>No messages yet.</div>
                        )}
                        {conversations.map((msg) => (
                            <div
                                key={msg.id}
                                style={{
                                    ...getSenderStyle(msg.sender),
                                    maxWidth: '80%', padding: '10px 14px', borderRadius: 14,
                                    fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                                }}
                            >
                                {msg.message}
                                <div style={{
                                    fontSize: 10, marginTop: 6, opacity: 0.65,
                                    color: msg.sender === 'bot' ? '#fff' : 'var(--fog)',
                                }}>
                                    {formatDate(msg.created_at)}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Appointments */}
                <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                        Appointments
                    </div>
                    {appointments.length === 0 && (
                        <div style={{ fontSize: 13, color: 'var(--fog)', background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', padding: 20 }}>
                            No viewing requests.
                        </div>
                    )}
                    {appointments.map((appt) => (
                        <div key={appt.id} style={{
                            background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                            padding: 16, marginBottom: 10,
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                                <div style={{ fontSize: 13, fontWeight: 700 }}>
                                    {appt.type} — {appt.neighbourhood}, {appt.city}
                                </div>
                                <span className="badge" style={{
                                    background: STATUS_COLORS[appt.status]?.bg || 'var(--mist)',
                                    color: STATUS_COLORS[appt.status]?.color || 'var(--ash)',
                                }}>
                                    {appt.status}
                                </span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--ash)', marginBottom: 4 }}>{formatXOF(appt.price)}</div>
                            <div style={{ fontSize: 12, color: 'var(--fog)' }}>
                                Requested: {appt.requested_datetime_text}
                                {appt.requested_datetime && ` (${formatDate(appt.requested_datetime)})`}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
