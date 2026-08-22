'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import api from '../../../../lib/api';
import { STATUSES as LEAD_STATUSES, STATUS_CONFIG as LEAD_STATUS_CONFIG, APPOINTMENT_STATUS_CONFIG, TEMPERATURE_CONFIG } from '../../../../lib/statusConfig';
import { useDashboardLanguage } from '../../../../lib/useDashboardLanguage';
import { dashboardStrings, propertyTypeLabels, timeOfDayLabels } from '../../../../lib/dashboardStrings';

// Locale follows the dashboard toggle, so date/time text stays consistent
// with everything else on the page instead of always rendering English-style.
//
// timeZone is pinned to UTC because Togo is UTC+0 and these are viewings that
// physically happen there — without this, toLocaleString silently renders in
// whatever zone the ADMIN's browser is in, so a 15:00 Lomé viewing showed as
// 20:30 to someone in India. Appointment times must not move with the viewer.

// Renders only what the bot has ACTUALLY established. An empty field is not
// shown at all rather than displayed as "—", so this panel reads as "here is
// what we know" instead of a mostly-blank form.
const requirementFields = (profile, t, lang) => {
    if (!profile) return [];
    const money = (n) => `${Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
    const beds = profile.bedrooms_min === profile.bedrooms_max
        ? profile.bedrooms_min
        : `${profile.bedrooms_min ?? '?'}-${profile.bedrooms_max ?? '?'}`;
    return [
        profile.transaction && { label: t.fieldTransaction, value: t.transactionLabels[profile.transaction] },
        profile.property_type && { label: t.fieldType, value: propertyTypeLabels[lang][profile.property_type] },
        (profile.neighbourhood || profile.city) && { label: t.fieldArea, value: [profile.neighbourhood, profile.city].filter(Boolean).join(', ') },
        profile.bedrooms_min != null && { label: t.fieldBedrooms, value: beds },
        profile.budget_max && {
            label: t.fieldBudget,
            // The stretch figure is shown alongside, not instead: "they said
            // 80 but would go to 90" is a different negotiating position.
            value: profile.budget_stretch_max
                ? `${money(profile.budget_max)} (${t.upTo} ${money(profile.budget_stretch_max)})`
                : money(profile.budget_max),
        },
        profile.timeline && { label: t.fieldTimeline, value: t.timelineLabels[profile.timeline] || profile.timeline },
        profile.purpose && { label: t.fieldPurpose, value: t.purposeLabels[profile.purpose] || profile.purpose },
    ].filter(Boolean);
};

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

// Best-precision-first; raw text is the last resort so it never shows blank.
// Mirrors the same helper on the appointments list page.
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
    const [profile, setProfile] = useState(null);
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [statusSaving, setStatusSaving] = useState(false);
    const [statusError, setStatusError] = useState('');
    const [replyText, setReplyText] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState('');
    const [notesDraft, setNotesDraft] = useState('');
    const [notesStatus, setNotesStatus] = useState('idle'); // idle | saving | saved | error
    const [lang] = useDashboardLanguage();
    const t = dashboardStrings[lang].leadDetail;
    const notesTimerRef = useRef(null);
    const notesLoadedRef = useRef(false); // don't overwrite the textarea once the admin starts editing

    useEffect(() => {
        notesLoadedRef.current = false;
        fetchLead();
        return () => {
            if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
        };
    }, [params.id]);

    // Real-time-ish conversation updates: poll every 5s while the tab is
    // visible, instead of forcing a manual refresh after every WhatsApp
    // message. No WebSocket/infra exists in this stack, so polling is the
    // pragmatic fit. Paused when hidden to avoid wasted requests.
    useEffect(() => {
        const interval = setInterval(() => {
            if (document.visibilityState === 'visible') {
                fetchLead({ silent: true });
            }
        }, 5000);
        return () => clearInterval(interval);
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
            setStatusError(t.statusUpdateError);
        } finally {
            setStatusSaving(false);
        }
    };

    const handleSendReply = async () => {
        const message = replyText.trim();
        if (!message || sending) return;

        setSendError('');
        setSending(true);
        try {
            await api.post(`/leads/${params.id}/reply`, { message });
            // Not persisted server-side (by design — see CLAUDE.md task notes),
            // so append it to local state only; it won't survive a refresh.
            setConversations((prev) => [
                ...prev,
                { id: `local-${Date.now()}`, sender: 'bot', message, created_at: new Date().toISOString() },
            ]);
            setReplyText('');
        } catch (err) {
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            setSendError(t.sendError);
        } finally {
            setSending(false);
        }
    };

    const fetchLead = async ({ silent = false } = {}) => {
        try {
            const response = await api.get(`/leads/${params.id}`);
            setLead(response.data.lead);
            // Admin replies (sendReply) aren't persisted server-side by design
            // (see handleSendReply), so a poll refetch must not drop them —
            // re-append whatever local-only messages are still in state after
            // the server's authoritative list.
            setConversations((prev) => {
                const localOnly = prev.filter((m) => String(m.id).startsWith('local-'));
                return [...response.data.conversations, ...localOnly];
            });
            setAppointments(response.data.appointments);
            // Server-owned and never edited locally, so a straight overwrite is
            // safe here (unlike conversations and notes above).
            setProfile(response.data.profile);
            setEvents(response.data.events || []);
            // Only seed the notes textarea once — a silent poll must never
            // clobber whatever the admin is currently typing.
            if (!notesLoadedRef.current) {
                setNotesDraft(response.data.lead.notes || '');
                notesLoadedRef.current = true;
            }
        } catch (err) {
            if (silent) return; // don't disrupt the page over a background poll hiccup
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            if (err.response?.status === 404) {
                setError(t.notFound);
                return;
            }
            setError(t.loadError);
        } finally {
            if (!silent) setLoading(false);
        }
    };

    const handleNotesChange = (value) => {
        setNotesDraft(value);
        setNotesStatus('idle');
        if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
        notesTimerRef.current = setTimeout(async () => {
            setNotesStatus('saving');
            try {
                await api.patch(`/leads/${params.id}/notes`, { notes: value });
                setNotesStatus('saved');
            } catch (err) {
                if (err.response?.status === 401) {
                    router.push('/login');
                    return;
                }
                setNotesStatus('error');
            }
        }, 800);
    };

    if (loading) {
        return <div style={{ fontSize: 13, color: 'var(--fog)' }}>{t.loading}</div>;
    }

    if (error) {
        return (
            <div>
                <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>{error}</div>
                <Link href="/dashboard" style={{ fontSize: 13, color: 'var(--ink)' }}>{t.backLink}</Link>
            </div>
        );
    }

    return (
        <div>
            <Link href="/dashboard" style={{ fontSize: 12, color: 'var(--fog)', textDecoration: 'none' }}>{t.backLink}</Link>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <h1 style={{ fontSize: 26, fontWeight: 800 }}>{lead.name || t.unknownName}</h1>
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
                        <option key={s} value={s}>{LEAD_STATUS_CONFIG[s].label[lang]}</option>
                    ))}
                </select>
                {statusSaving && <span style={{ fontSize: 11, color: 'var(--fog)' }}>{t.saving}</span>}
            </div>
            {statusError && <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 8 }}>{statusError}</div>}
            <div style={{ fontSize: 13, color: 'var(--fog)', fontFamily: 'monospace', marginBottom: 4 }}>{lead.phone}</div>
            <div style={{ fontSize: 12, color: 'var(--fog)', marginBottom: 28 }}>
                {t.firstContact} {formatDate(lead.created_at, lang)} · {t.lastMessage} {formatDate(lead.last_message_at, lang)}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 24 }}>
                {/* Conversation */}
                <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                        {t.conversation}
                    </div>
                    <div style={{
                        background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                        padding: 20, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 600, overflowY: 'auto',
                    }}>
                        {conversations.length === 0 && (
                            <div style={{ fontSize: 13, color: 'var(--fog)' }}>{t.noMessages}</div>
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
                                    {formatDate(msg.created_at, lang)}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <textarea
                            value={replyText}
                            onChange={(e) => setReplyText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSendReply();
                                }
                            }}
                            placeholder={t.replyPlaceholder}
                            disabled={sending}
                            rows={2}
                            style={{
                                flex: 1, padding: '10px 14px', fontSize: 13, fontFamily: 'inherit',
                                border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)',
                                outline: 'none', resize: 'vertical', color: 'var(--ink)',
                            }}
                        />
                        <button
                            onClick={handleSendReply}
                            disabled={sending || !replyText.trim()}
                            style={{
                                padding: '0 18px', fontSize: 13, fontWeight: 700,
                                background: 'var(--ink)', color: '#fff', border: 'none',
                                borderRadius: 'var(--r-btn)',
                                cursor: sending || !replyText.trim() ? 'default' : 'pointer',
                                opacity: sending || !replyText.trim() ? 0.6 : 1,
                            }}
                        >
                            {sending ? t.sending : t.send}
                        </button>
                    </div>
                    {sendError && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 6 }}>{sendError}</div>}
                </div>

                {/* What the bot has worked out about them. Null for a lead who
                    has only ever said "hi" — no profile row exists yet. */}
                {profile && (
                    <div style={{ marginBottom: 24 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                {t.requirement}
                            </span>
                            <span style={{
                                fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                                background: TEMPERATURE_CONFIG[profile.lead_temperature]?.bg || 'var(--mist)',
                                color: TEMPERATURE_CONFIG[profile.lead_temperature]?.color || 'var(--ash)',
                            }}>
                                {TEMPERATURE_CONFIG[profile.lead_temperature]?.label[lang] || profile.lead_temperature}
                                {' · '}{profile.lead_score}/100
                            </span>
                            {profile.needs_human && (
                                <span style={{
                                    fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                                    background: '#fef3c7', color: '#92400e',
                                }}>
                                    {t.needsHuman}
                                </span>
                            )}
                        </div>

                        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', padding: 16 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                                {requirementFields(profile, t, lang).map((f) => (
                                    <div key={f.label}>
                                        <div style={{ fontSize: 10, color: 'var(--fog)', marginBottom: 2 }}>{f.label}</div>
                                        <div style={{ fontSize: 13, fontWeight: 600 }}>{f.value}</div>
                                    </div>
                                ))}
                            </div>
                            {/* Nothing extracted yet — say so rather than
                                rendering an empty grid that looks broken. */}
                            {requirementFields(profile, t, lang).length === 0 && (
                                <div style={{ fontSize: 12, color: 'var(--fog)' }}>{t.requirementEmpty}</div>
                            )}
                        </div>
                    </div>
                )}

                {/* What they actually did — the transcript says what was said,
                    this says what happened. */}
                {events.length > 0 && (
                    <div style={{ marginBottom: 24 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                            {t.activity}
                        </div>
                        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', padding: 16 }}>
                            {events.slice(0, 12).map((e, i) => (
                                <div key={e.id} style={{
                                    display: 'flex', justifyContent: 'space-between', gap: 10,
                                    padding: '6px 0',
                                    borderBottom: i < Math.min(events.length, 12) - 1 ? '1px solid var(--ice)' : 'none',
                                }}>
                                    <span style={{ fontSize: 12 }}>
                                        {t.eventLabels[e.event_type] || e.event_type}
                                        {e.neighbourhood && (
                                            <span style={{ color: 'var(--fog)' }}>
                                                {' — '}{propertyTypeLabels[lang][e.property_type] || e.property_type}, {e.neighbourhood}
                                            </span>
                                        )}
                                    </span>
                                    <span style={{ fontSize: 10, color: 'var(--fog)', whiteSpace: 'nowrap' }}>
                                        {formatDate(e.created_at, lang)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Appointments */}
                <div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                        {t.appointments}
                    </div>
                    {appointments.length === 0 && (
                        <div style={{ fontSize: 13, color: 'var(--fog)', background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', padding: 20 }}>
                            {t.noAppointments}
                        </div>
                    )}
                    {appointments.map((appt) => (
                        <div key={appt.id} style={{
                            background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                            padding: 16, marginBottom: 10,
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                                <div style={{ fontSize: 13, fontWeight: 700 }}>
                                    {propertyTypeLabels[lang][appt.type] || appt.type} — {appt.neighbourhood}, {appt.city}
                                </div>
                                <span className="badge" style={{
                                    background: APPOINTMENT_STATUS_CONFIG[appt.status]?.bg || 'var(--mist)',
                                    color: APPOINTMENT_STATUS_CONFIG[appt.status]?.color || 'var(--ash)',
                                }}>
                                    {APPOINTMENT_STATUS_CONFIG[appt.status]?.label[lang] || appt.status}
                                </span>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--ash)', marginBottom: 4 }}>{formatXOF(appt.price)}</div>
                            <div style={{ fontSize: 12, color: 'var(--fog)' }}>
                                {t.requested} {formatRequested(appt, lang)}
                            </div>
                        </div>
                    ))}

                    {/* Admin notes — free text about this lead, separate from
                        the WhatsApp transcript, auto-saved as they type. */}
                    <div style={{ marginTop: 24 }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
                            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--fog)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                {t.notes}
                            </div>
                            <span style={{ fontSize: 11, color: notesStatus === 'error' ? '#b91c1c' : 'var(--fog)' }}>
                                {notesStatus === 'saving' && t.notesSaving}
                                {notesStatus === 'saved' && t.notesSaved}
                                {notesStatus === 'error' && t.notesError}
                            </span>
                        </div>
                        <textarea
                            value={notesDraft}
                            onChange={(e) => handleNotesChange(e.target.value)}
                            placeholder={t.notesPlaceholder}
                            rows={5}
                            style={{
                                width: '100%', padding: '10px 14px', fontSize: 13, fontFamily: 'inherit',
                                border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)',
                                outline: 'none', resize: 'vertical', color: 'var(--ink)', background: '#fff',
                            }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
