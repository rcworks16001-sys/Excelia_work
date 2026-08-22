'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../lib/api';

// Poll interval. Matches the lead-detail page's existing 5s conversation poll
// in spirit but is deliberately slower — the bell is ambient awareness, not a
// live feed, and this request runs on EVERY dashboard page.
const POLL_MS = 20000;

// Per-type presentation. Only 'needs_human' is styled as urgent; a bell where
// everything is red teaches people to ignore red.
const TYPE_STYLE = {
    needs_human: { icon: '🙋', color: '#b91c1c' },
    hot_lead: { icon: '🔥', color: '#b45309' },
    appointment_booked: { icon: '📅', color: 'var(--ink)' },
};

// Handoff reasons arrive as machine values (metadata.reason) so they can be
// rendered in whichever language the admin is currently using — mirrors the
// handoff_reason enum in the backend's NLU schemas.
const HANDOFF_REASON_LABEL = {
    asked_for_agent: { fr: 'A demandé à parler à un conseiller', en: 'Asked to speak to an advisor' },
    negotiation: { fr: 'Veut négocier le prix ou les conditions', en: 'Wants to negotiate price or terms' },
    complaint: { fr: 'Réclamation', en: 'Complaint' },
    legal_or_financial: { fr: 'Question juridique ou financière', en: 'Legal or financial question' },
};

const relativeTime = (iso, lang) => {
    const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (lang === 'fr') {
        if (seconds < 60) return "à l'instant";
        if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)}min`;
        if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)}h`;
        return `il y a ${Math.floor(seconds / 86400)}j`;
    }
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
};

export default function NotificationBell({ t, lang }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [items, setItems] = useState([]);
    const [unread, setUnread] = useState(0);
    const [error, setError] = useState('');
    const panelRef = useRef(null);

    const load = useCallback(async () => {
        try {
            const response = await api.get('/notifications');
            setItems(response.data.notifications);
            setUnread(response.data.unreadCount);
            setError('');
        } catch (err) {
            // Silent on the badge — a transient failure shouldn't throw an
            // error banner across a dashboard the admin is using for something
            // else. It surfaces only inside the open panel.
            setError(t.notificationsError);
        }
    }, [t]);

    useEffect(() => {
        load();
        // Pause polling when the tab is hidden — the same treatment the lead
        // detail page gives its conversation poll.
        const tick = () => { if (!document.hidden) load(); };
        const id = setInterval(tick, POLL_MS);
        const onVisible = () => { if (!document.hidden) load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
    }, [load]);

    // Click-away and Escape to close.
    useEffect(() => {
        if (!open) return;
        const onClick = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onClick);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
    }, [open]);

    const openLead = async (n) => {
        setOpen(false);
        // Optimistic: mark read locally so the badge responds instantly, then
        // persist. A failed mark-read is harmless — the next poll corrects it.
        if (!n.read_at) {
            setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
            setUnread((u) => Math.max(0, u - 1));
            try { await api.patch(`/notifications/${n.id}/read`); } catch { /* next poll reconciles */ }
        }
        router.push(`/dashboard/leads/${n.lead_id}`);
    };

    const markAll = async () => {
        setItems((prev) => prev.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })));
        setUnread(0);
        try { await api.patch('/notifications/read-all'); } catch { load(); }
    };

    const typeLabel = (type) => ({
        needs_human: t.notifNeedsHuman,
        hot_lead: t.notifHotLead,
        appointment_booked: t.notifAppointment,
    }[type] || type);

    return (
        <div ref={panelRef} style={{ position: 'relative' }}>
            <button
                onClick={() => setOpen((v) => !v)}
                aria-label={t.notifications}
                style={{
                    position: 'relative', width: 36, height: 36, borderRadius: '50%',
                    border: '1px solid var(--ice)', background: '#fff', cursor: 'pointer',
                    fontSize: 15, lineHeight: '34px', textAlign: 'center', padding: 0,
                }}
            >
                🔔
                {unread > 0 && (
                    <span style={{
                        position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, padding: '0 5px',
                        borderRadius: 9, background: '#b91c1c', color: '#fff', fontSize: 10, fontWeight: 800,
                        lineHeight: '18px', textAlign: 'center',
                    }}>
                        {unread > 9 ? '9+' : unread}
                    </span>
                )}
            </button>

            {open && (
                <div style={{
                    position: 'absolute', top: 44, right: 0, width: 340, maxHeight: 420, overflowY: 'auto',
                    background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                    boxShadow: '0 8px 28px rgba(0,0,0,0.12)', zIndex: 200,
                }}>
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '12px 14px', borderBottom: '1px solid var(--ice)', position: 'sticky', top: 0, background: '#fff',
                    }}>
                        <span style={{ fontSize: 13, fontWeight: 800 }}>{t.notifications}</span>
                        {unread > 0 && (
                            <button onClick={markAll} style={{
                                fontSize: 11, fontWeight: 600, color: 'var(--ash)', background: 'none',
                                border: 'none', cursor: 'pointer', padding: 0,
                            }}>
                                {t.notificationsMarkAll}
                            </button>
                        )}
                    </div>

                    {error && <div style={{ padding: 14, fontSize: 12, color: '#b91c1c' }}>{error}</div>}

                    {!error && items.length === 0 && (
                        <div style={{ padding: '28px 14px', textAlign: 'center', fontSize: 12, color: 'var(--fog)' }}>
                            {t.notificationsEmpty}
                        </div>
                    )}

                    {items.map((n) => {
                        const style = TYPE_STYLE[n.type] || {};
                        // Prefer a localised reason over the stored detail; fall
                        // back to detail for types that carry real prose.
                        const reason = n.metadata?.reason;
                        const detail = (reason && HANDOFF_REASON_LABEL[reason]?.[lang]) || n.detail;
                        return (
                            <div
                                key={n.id}
                                onClick={() => openLead(n)}
                                style={{
                                    display: 'flex', gap: 10, padding: '11px 14px', cursor: 'pointer',
                                    borderBottom: '1px solid var(--ice)',
                                    // Unread is tinted, not bold-only — scannable at a glance.
                                    background: n.read_at ? '#fff' : 'var(--mist)',
                                }}
                            >
                                <span style={{ fontSize: 15, lineHeight: '18px' }}>{style.icon}</span>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontSize: 10, fontWeight: 700, color: style.color, marginBottom: 2 }}>
                                        {typeLabel(n.type)}
                                    </div>
                                    <div style={{ fontSize: 12.5, fontWeight: n.read_at ? 500 : 700, color: 'var(--ink)' }}>
                                        {n.title}
                                    </div>
                                    {detail && (
                                        <div style={{
                                            fontSize: 11, color: 'var(--ash)', marginTop: 2,
                                            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                                            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                                        }}>
                                            {detail}
                                        </div>
                                    )}
                                    <div style={{ fontSize: 10, color: 'var(--fog)', marginTop: 3 }}>
                                        {n.lead_phone} · {relativeTime(n.created_at, lang)}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
