'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../../../lib/api';
import { useDashboardLanguage } from '../../../lib/useDashboardLanguage';
import { dashboardStrings } from '../../../lib/dashboardStrings';
import { LISTING_STATUSES, LISTING_STATUS_CONFIG, TRANSACTIONS, TRANSACTION_CONFIG } from '../../../lib/statusConfig';

const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
};

function PropertyCard({ property, onPhotosChanged, onVideoChanged, onDeleted, onListingStatusChanged, onEnlarge, t, lang }) {
    const fileInputRef = useRef(null);
    const videoInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const [videoUploading, setVideoUploading] = useState(false);
    const [videoError, setVideoError] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [reservedForDraft, setReservedForDraft] = useState(property.reserved_for || '');
    const [statusError, setStatusError] = useState('');
    // Keep the draft in sync when the note changes from outside this input
    // (e.g. cleared server-side after a status change away from 'reserved').
    useEffect(() => {
        setReservedForDraft(property.reserved_for || '');
    }, [property.reserved_for]);
    const photos = property.photos || [];
    const hasPhoto = photos.length > 0;
    // The full enlargeable gallery for this listing, in display order — photo
    // thumbnails first, walkthrough video last (if any) — so the lightbox can
    // navigate between all of a property's media, not just one item at a time.
    const galleryItems = [
        ...photos.map((url) => ({ type: 'image', url })),
        ...(property.video_url ? [{ type: 'video', url: property.video_url }] : []),
    ];
    // description is authored in French; description_en is the cached one-time
    // translation. Falls back to French if this listing hasn't been translated
    // yet (run `npm run backfill-translations` in backend/ to fill new ones).
    const description = lang === 'en' ? (property.description_en || property.description) : property.description;

    // Multiple files: upload one at a time to the existing single-file
    // endpoint (no backend change needed), updating the gallery after each
    // one so progress is visible rather than waiting for the whole batch.
    const handleFileChange = async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = ''; // allow picking the same file(s) again later
        if (files.length === 0) return;

        setUploadError('');
        setUploading(true);
        try {
            for (const file of files) {
                const formData = new FormData();
                formData.append('photo', file);
                const response = await api.post(`/properties/${property.id}/photos`, formData);
                onPhotosChanged(property.id, response.data.photos);
            }
        } catch (err) {
            setUploadError(t.uploadError);
        } finally {
            setUploading(false);
        }
    };

    const handleDeletePhoto = async (url) => {
        try {
            const response = await api.delete(`/properties/${property.id}/photos`, { data: { url } });
            onPhotosChanged(property.id, response.data.photos);
        } catch (err) {
            setUploadError(t.deleteError);
        }
    };

    const handleVideoChange = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;

        setVideoError('');
        setVideoUploading(true);
        try {
            const formData = new FormData();
            formData.append('video', file);
            const response = await api.post(`/properties/${property.id}/video`, formData);
            onVideoChanged(property.id, response.data.video_url);
        } catch (err) {
            setVideoError(t.videoUploadError);
        } finally {
            setVideoUploading(false);
        }
    };

    const handleDeleteVideo = async () => {
        try {
            const response = await api.delete(`/properties/${property.id}/video`);
            onVideoChanged(property.id, response.data.video_url);
        } catch (err) {
            setVideoError(t.videoDeleteError);
        }
    };

    // Two-step: the button opens an in-app confirm dialog naming this exact
    // listing, rather than a bare window.confirm() — the admin should see
    // which property they're about to permanently remove, not just a generic
    // browser prompt.
    const handleDeleteProperty = () => {
        setDeleteError('');
        setShowDeleteConfirm(true);
    };

    const confirmDeleteProperty = async () => {
        setShowDeleteConfirm(false);
        setDeleting(true);
        try {
            await api.delete(`/properties/${property.id}`);
            onDeleted(property.id);
        } catch (err) {
            // The backend blocks deletion (409) when appointments reference
            // this listing, with a message explaining why — show that
            // directly rather than a generic failure.
            setDeleteError(err.response?.data?.error || t.deletePropertyError);
            setDeleting(false);
        }
    };

    // Optimistic, mirrors handleStatusChange on the Appointments page: update
    // local state immediately, PATCH in the background, revert on failure.
    const handleStatusSelect = async (e) => {
        const newStatus = e.target.value;
        const previousStatus = property.listing_status;
        const previousNote = property.reserved_for;
        // Moving away from 'reserved' clears the note (mirrors what the
        // backend does); moving TO 'reserved' keeps whatever note already
        // existed rather than blanking a note the admin is about to re-type.
        const nextNote = newStatus === 'reserved' ? previousNote : null;
        setStatusError('');
        onListingStatusChanged(property.id, newStatus, nextNote);
        try {
            await api.patch(`/properties/${property.id}/status`, { listing_status: newStatus, reserved_for: nextNote });
        } catch (err) {
            onListingStatusChanged(property.id, previousStatus, previousNote);
            setStatusError(t.statusUpdateError);
        }
    };

    const handleReservedForBlur = async () => {
        const trimmed = reservedForDraft.trim();
        if (property.listing_status !== 'reserved' || trimmed === (property.reserved_for || '')) return;
        setStatusError('');
        onListingStatusChanged(property.id, 'reserved', trimmed || null);
        try {
            await api.patch(`/properties/${property.id}/status`, { listing_status: 'reserved', reserved_for: trimmed });
        } catch (err) {
            onListingStatusChanged(property.id, property.listing_status, property.reserved_for);
            setStatusError(t.statusUpdateError);
        }
    };

    return (
        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
            {/* Cover photo, or a clear placeholder if none uploaded yet. */}
            <div
                onClick={() => hasPhoto && onEnlarge(galleryItems, 0)}
                style={{
                    height: 140, background: 'var(--mist)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4, position: 'relative',
                    cursor: hasPhoto ? 'zoom-in' : 'default',
                }}
            >
                {hasPhoto ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photos[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                    <>
                        <span style={{ fontSize: 24 }}>📷</span>
                        <span style={{ fontSize: 11, color: 'var(--fog)' }}>{t.photosComingSoon}</span>
                    </>
                )}
            </div>

            <div style={{ padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 2 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>
                        {t.typeLabels[property.type] || property.type}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <span style={{
                            fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                            background: TRANSACTION_CONFIG[property.transaction]?.bg || 'var(--mist)',
                            color: TRANSACTION_CONFIG[property.transaction]?.color || 'var(--ash)',
                        }}>
                            {TRANSACTION_CONFIG[property.transaction]?.label[lang] || property.transaction}
                        </span>
                        <span style={{
                            fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                            background: LISTING_STATUS_CONFIG[property.listing_status]?.bg || 'var(--mist)',
                            color: LISTING_STATUS_CONFIG[property.listing_status]?.color || 'var(--ash)',
                        }}>
                            {LISTING_STATUS_CONFIG[property.listing_status]?.label[lang] || property.listing_status}
                        </span>
                    </div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--fog)', marginBottom: 10 }}>
                    {property.neighbourhood}, {property.city}
                    {property.bedrooms ? ` · ${property.bedrooms} ${t.bedroomsAbbrev}` : ''}
                </div>

                <div style={{ marginBottom: 10 }}>
                    <select
                        value={property.listing_status}
                        onChange={handleStatusSelect}
                        style={{
                            fontSize: 11, fontWeight: 600, padding: '5px 8px', borderRadius: 'var(--r-btn)',
                            border: '1px solid var(--ice)', background: '#fff', color: 'var(--ink)', cursor: 'pointer',
                        }}
                    >
                        {LISTING_STATUSES.map((s) => (
                            <option key={s} value={s}>{LISTING_STATUS_CONFIG[s].label[lang]}</option>
                        ))}
                    </select>
                    {property.listing_status === 'reserved' && (
                        <div style={{ marginTop: 6 }}>
                            <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--ash)', marginBottom: 3 }}>
                                {t.reservedForLabel}
                            </label>
                            <input
                                type="text"
                                value={reservedForDraft}
                                onChange={(e) => setReservedForDraft(e.target.value)}
                                onBlur={handleReservedForBlur}
                                placeholder={t.reservedForPlaceholder}
                                style={{
                                    width: '100%', fontSize: 11, padding: '6px 8px', border: '1px solid var(--ice)',
                                    borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)',
                                }}
                            />
                        </div>
                    )}
                    {statusError && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>{statusError}</div>}
                </div>

                <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>{formatXOF(property.price)}</div>
                {description && (
                    <p style={{ fontSize: 12, color: 'var(--ash)', lineHeight: 1.5, marginBottom: 8 }}>
                        {description}
                    </p>
                )}

                {/* Photo thumbnails — click to enlarge, × to remove */}
                {hasPhoto && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                        {photos.map((url, photoIndex) => (
                            <div key={url} style={{ position: 'relative', width: 44, height: 44 }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                    src={url}
                                    alt=""
                                    onClick={() => onEnlarge(galleryItems, photoIndex)}
                                    style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--ice)', cursor: 'zoom-in' }}
                                />
                                <button
                                    onClick={() => handleDeletePhoto(url)}
                                    title="Remove photo"
                                    style={{
                                        position: 'absolute', top: -6, right: -6, width: 18, height: 18,
                                        borderRadius: '50%', border: 'none', background: 'var(--ink)', color: '#fff',
                                        fontSize: 11, lineHeight: '18px', textAlign: 'center', cursor: 'pointer', padding: 0,
                                    }}
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    style={{
                        fontSize: 11, fontWeight: 600, padding: '6px 12px', borderRadius: 'var(--r-btn)',
                        border: '1px solid var(--ice)', background: 'var(--mist)', color: 'var(--ash)',
                        cursor: uploading ? 'default' : 'pointer', marginBottom: 8, marginRight: 6,
                    }}
                >
                    {uploading ? t.uploading : t.uploadPhoto}
                </button>
                {uploadError && <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 8 }}>{uploadError}</div>}

                {/* Walkthrough video — a small thumbnail like the photos, not a
                    full-width player; click to enlarge and play. */}
                {property.video_url && (
                    <div style={{ marginBottom: 10 }}>
                        <div
                            onClick={() => onEnlarge(galleryItems, galleryItems.length - 1)}
                            style={{
                                position: 'relative', width: 44, height: 44, borderRadius: 6,
                                border: '1px solid var(--ice)', overflow: 'hidden', cursor: 'zoom-in', background: '#000',
                            }}
                        >
                            <video src={property.video_url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted />
                            <div style={{
                                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                color: '#fff', fontSize: 14, textShadow: '0 1px 3px rgba(0,0,0,0.6)',
                            }}>
                                ▶
                            </div>
                        </div>
                        <button
                            onClick={handleDeleteVideo}
                            style={{
                                fontSize: 11, color: '#b91c1c', background: 'none', border: 'none',
                                cursor: 'pointer', padding: 0, marginTop: 4,
                            }}
                        >
                            {t.removeVideo}
                        </button>
                    </div>
                )}

                <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    onChange={handleVideoChange}
                    style={{ display: 'none' }}
                />
                <button
                    onClick={() => videoInputRef.current?.click()}
                    disabled={videoUploading}
                    style={{
                        fontSize: 11, fontWeight: 600, padding: '6px 12px', borderRadius: 'var(--r-btn)',
                        border: '1px solid var(--ice)', background: 'var(--mist)', color: 'var(--ash)',
                        cursor: videoUploading ? 'default' : 'pointer', marginBottom: 8,
                    }}
                >
                    {videoUploading ? t.uploading : (property.video_url ? t.replaceVideo : t.uploadVideo)}
                </button>
                {videoError && <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 8 }}>{videoError}</div>}

                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    fontSize: 11, color: 'var(--fog)', borderTop: '1px solid var(--ice)', paddingTop: 8,
                }}>
                    {property.agency_contact}
                    <button
                        onClick={handleDeleteProperty}
                        disabled={deleting}
                        style={{
                            fontSize: 11, fontWeight: 600, color: '#b91c1c', background: 'none', border: 'none',
                            cursor: deleting ? 'default' : 'pointer', padding: 0,
                        }}
                    >
                        {t.deleteProperty}
                    </button>
                </div>
                {deleteError && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 6 }}>{deleteError}</div>}
            </div>

            {showDeleteConfirm && (
                <div
                    onClick={() => setShowDeleteConfirm(false)}
                    style={{
                        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
                    }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            background: '#fff', borderRadius: 'var(--r-card)', padding: 24,
                            width: '100%', maxWidth: 360,
                        }}
                    >
                        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8, color: 'var(--ink)' }}>
                            {t.deletePropertyTitle}
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--ash)', marginBottom: 4 }}>
                            {t.typeLabels[property.type] || property.type} — {property.neighbourhood}, {property.city} · {formatXOF(property.price)}
                        </div>
                        <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 20 }}>
                            {t.deletePropertyWarning}
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button
                                onClick={() => setShowDeleteConfirm(false)}
                                style={{
                                    fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 'var(--r-btn)',
                                    border: '1px solid var(--ice)', background: '#fff', color: 'var(--ash)', cursor: 'pointer',
                                }}
                            >
                                {t.addCancel}
                            </button>
                            <button
                                onClick={confirmDeleteProperty}
                                style={{
                                    fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 'var(--r-btn)',
                                    border: 'none', background: '#b91c1c', color: '#fff', cursor: 'pointer',
                                }}
                            >
                                {t.deleteProperty}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function SkeletonCard() {
    return (
        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
            <div className="skeleton" style={{ height: 140 }} />
            <div style={{ padding: 16 }}>
                <div className="skeleton" style={{ height: 14, width: '50%', marginBottom: 8 }} />
                <div className="skeleton" style={{ height: 11, width: '70%', marginBottom: 12 }} />
                <div className="skeleton" style={{ height: 18, width: '40%' }} />
            </div>
        </div>
    );
}

// Fullscreen overlay for a property's full media gallery (photos + video).
// Closes on backdrop click, × button, or Escape. Navigates with the
// on-screen ‹ › buttons or the Left/Right arrow keys, wrapping around at
// either end so browsing feels continuous.
function Lightbox({ gallery, onClose }) {
    const [index, setIndex] = useState(0);

    // Reset to whichever item was actually clicked, every time a NEW gallery
    // is opened (not on every re-render — gallery is a fresh array each
    // render, so key off its identity via the items themselves changing).
    useEffect(() => {
        if (gallery) setIndex(gallery.startIndex);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gallery?.items, gallery?.startIndex]);

    const items = gallery?.items || [];
    const goPrev = () => setIndex((i) => (i - 1 + items.length) % items.length);
    const goNext = () => setIndex((i) => (i + 1) % items.length);

    useEffect(() => {
        if (!gallery) return;
        const onKeyDown = (e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowLeft' && items.length > 1) goPrev();
            else if (e.key === 'ArrowRight' && items.length > 1) goNext();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gallery, items.length, onClose]);

    if (!gallery || items.length === 0) return null;
    const media = items[index];
    const navButtonStyle = {
        position: 'absolute', top: '50%', transform: 'translateY(-50%)', width: 44, height: 44, borderRadius: '50%',
        border: 'none', background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 22,
        cursor: 'pointer', lineHeight: '44px', textAlign: 'center',
    };

    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1000,
                display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }}
        >
            <button
                onClick={onClose}
                style={{
                    position: 'absolute', top: 20, right: 24, width: 36, height: 36, borderRadius: '50%',
                    border: 'none', background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 18,
                    cursor: 'pointer', lineHeight: '36px', textAlign: 'center', zIndex: 1,
                }}
            >
                ×
            </button>

            {items.length > 1 && (
                <>
                    <button onClick={(e) => { e.stopPropagation(); goPrev(); }} style={{ ...navButtonStyle, left: 16 }}>‹</button>
                    <button onClick={(e) => { e.stopPropagation(); goNext(); }} style={{ ...navButtonStyle, right: 16 }}>›</button>
                    <div style={{
                        position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
                        color: '#fff', fontSize: 12, background: 'rgba(255,255,255,0.15)', padding: '4px 10px', borderRadius: 12,
                    }}>
                        {index + 1} / {items.length}
                    </div>
                </>
            )}

            {media.type === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={media.url}
                    alt=""
                    onClick={(e) => e.stopPropagation()}
                    style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }}
                />
            ) : (
                <video
                    key={media.url}
                    src={media.url}
                    controls
                    autoPlay
                    onClick={(e) => e.stopPropagation()}
                    style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }}
                />
            )}
        </div>
    );
}

const ADD_FORM_DEFAULTS = { city: '', neighbourhood: '', type: '', price: '', bedrooms: '', description: '', descriptionLang: 'fr', transaction: 'rent' };

export default function PropertiesPage() {
    const router = useRouter();
    const [properties, setProperties] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [transactionFilter, setTransactionFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [gallery, setGallery] = useState(null); // { items: [{type,url}], startIndex } | null
    const [showAddForm, setShowAddForm] = useState(false);
    const [addForm, setAddForm] = useState(ADD_FORM_DEFAULTS);
    const [addSaving, setAddSaving] = useState(false);
    const [addError, setAddError] = useState('');
    const [lang] = useDashboardLanguage();
    const t = dashboardStrings[lang].properties;

    useEffect(() => {
        (async () => {
            try {
                const response = await api.get('/properties');
                setProperties(response.data.properties);
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

    const handlePhotosChanged = (propertyId, newPhotos) => {
        setProperties((prev) => prev.map((p) => (p.id === propertyId ? { ...p, photos: newPhotos } : p)));
    };

    const handleVideoChanged = (propertyId, newVideoUrl) => {
        setProperties((prev) => prev.map((p) => (p.id === propertyId ? { ...p, video_url: newVideoUrl } : p)));
    };

    const handlePropertyDeleted = (propertyId) => {
        setProperties((prev) => prev.filter((p) => p.id !== propertyId));
    };

    const handleListingStatusChanged = (propertyId, listing_status, reserved_for) => {
        setProperties((prev) => prev.map((p) => (p.id === propertyId ? { ...p, listing_status, reserved_for } : p)));
    };

    const handleAddSubmit = async (e) => {
        e.preventDefault();
        setAddError('');
        setAddSaving(true);
        try {
            const response = await api.post('/properties', {
                city: addForm.city,
                neighbourhood: addForm.neighbourhood,
                type: addForm.type,
                price: addForm.price ? Number(addForm.price) : undefined,
                bedrooms: addForm.bedrooms === '' ? null : Number(addForm.bedrooms),
                description: addForm.description || null,
                descriptionLang: addForm.descriptionLang,
                transaction: addForm.transaction,
            });
            setProperties((prev) => [response.data.property, ...prev]);
            setAddForm(ADD_FORM_DEFAULTS);
            setShowAddForm(false);
        } catch (err) {
            if (err.response?.status === 401) {
                router.push('/login');
                return;
            }
            setAddError(err.response?.data?.error || t.addError);
        } finally {
            setAddSaving(false);
        }
    };

    const types = ['all', ...Object.keys(t.typeLabels)];
    const filtered = properties.filter((p) => {
        if (typeFilter !== 'all' && p.type !== typeFilter) return false;
        if (transactionFilter !== 'all' && p.transaction !== transactionFilter) return false;
        if (!search) return true;
        // Match every word in the query against the combined fields, not the
        // whole query against one field — a copy-pasted "Neighbourhood, City"
        // string (exactly as the card displays it) otherwise never matches,
        // since no single field contains that full comma-separated string.
        const haystack = `${p.neighbourhood || ''} ${p.city || ''} ${p.description || ''} ${p.description_en || ''}`.toLowerCase();
        const words = search.toLowerCase().replace(/[,.;]/g, ' ').split(/\s+/).filter(Boolean);
        return words.every((w) => haystack.includes(w));
    });

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4, flexWrap: 'wrap', gap: 10 }}>
                <div>
                    <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
                    <p style={{ fontSize: 13, color: 'var(--fog)' }}>
                        {loading ? t.loading : t.listingsCount(properties.length)}
                    </p>
                </div>
                <button
                    onClick={() => setShowAddForm((v) => !v)}
                    style={{
                        fontSize: 13, fontWeight: 700, padding: '9px 16px', borderRadius: 'var(--r-btn)',
                        border: 'none', background: 'var(--ink)', color: '#fff', cursor: 'pointer',
                    }}
                >
                    {t.addProperty}
                </button>
            </div>

            {showAddForm && (
                <form
                    onSubmit={handleAddSubmit}
                    style={{
                        background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                        padding: 16, marginBottom: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10,
                    }}
                >
                    <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ash)', marginBottom: 4 }}>{t.addFieldCity}</label>
                        <input required value={addForm.city} onChange={(e) => setAddForm((f) => ({ ...f, city: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)' }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ash)', marginBottom: 4 }}>{t.addFieldNeighbourhood}</label>
                        <input required value={addForm.neighbourhood} onChange={(e) => setAddForm((f) => ({ ...f, neighbourhood: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)' }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ash)', marginBottom: 4 }}>{t.addFieldType}</label>
                        <select required value={addForm.type} onChange={(e) => setAddForm((f) => ({ ...f, type: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)' }}>
                            <option value="" disabled>—</option>
                            {Object.keys(t.typeLabels).map((type) => (
                                <option key={type} value={type}>{t.typeLabels[type]}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ash)', marginBottom: 4 }}>{t.addFieldTransaction}</label>
                        <select value={addForm.transaction} onChange={(e) => setAddForm((f) => ({ ...f, transaction: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)' }}>
                            {TRANSACTIONS.map((tx) => (
                                <option key={tx} value={tx}>{TRANSACTION_CONFIG[tx].label[lang]}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ash)', marginBottom: 4 }}>{t.addFieldPrice}</label>
                        <input required type="number" min="1" value={addForm.price} onChange={(e) => setAddForm((f) => ({ ...f, price: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)' }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--ash)', marginBottom: 4 }}>{t.addFieldBedrooms}</label>
                        <input type="number" min="0" value={addForm.bedrooms} onChange={(e) => setAddForm((f) => ({ ...f, bedrooms: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', color: 'var(--ink)' }} />
                    </div>
                    <div style={{ gridColumn: '1 / -1' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                            <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--ash)' }}>{t.addFieldDescription}</label>
                            {/* Which language was actually typed — the OTHER
                                language is auto-translated on save (Claude),
                                since `description` is always treated as
                                French everywhere else in the app. */}
                            <div style={{ display: 'flex', gap: 2 }}>
                                {['fr', 'en'].map((code) => (
                                    <button
                                        key={code}
                                        type="button"
                                        onClick={() => setAddForm((f) => ({ ...f, descriptionLang: code }))}
                                        style={{
                                            fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
                                            border: '1px solid var(--ice)', cursor: 'pointer',
                                            background: addForm.descriptionLang === code ? 'var(--ink)' : '#fff',
                                            color: addForm.descriptionLang === code ? '#fff' : 'var(--ash)',
                                        }}
                                    >
                                        {code.toUpperCase()}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <textarea rows={2} value={addForm.description} onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
                            style={{ width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', outline: 'none', resize: 'vertical', color: 'var(--ink)' }} />
                    </div>
                    <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, alignItems: 'center' }}>
                        <button type="submit" disabled={addSaving}
                            style={{ fontSize: 13, fontWeight: 700, padding: '8px 16px', borderRadius: 'var(--r-btn)', border: 'none', background: 'var(--ink)', color: '#fff', cursor: addSaving ? 'default' : 'pointer' }}>
                            {addSaving ? t.addSaving : t.addSubmit}
                        </button>
                        <button type="button" onClick={() => { setShowAddForm(false); setAddForm(ADD_FORM_DEFAULTS); setAddError(''); }}
                            style={{ fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 'var(--r-btn)', border: '1px solid var(--ice)', background: '#fff', color: 'var(--ash)', cursor: 'pointer' }}>
                            {t.addCancel}
                        </button>
                        {addError && <span style={{ fontSize: 12, color: '#b91c1c' }}>{addError}</span>}
                    </div>
                </form>
            )}

            <div style={{ display: 'flex', gap: 3, background: '#fff', border: '1px solid var(--ice)', borderRadius: 12, padding: 4, marginBottom: 10, flexWrap: 'wrap', width: 'fit-content' }}>
                {['all', ...TRANSACTIONS].map((tx) => (
                    <button
                        key={tx}
                        onClick={() => setTransactionFilter(tx)}
                        style={{
                            padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600,
                            cursor: 'pointer', background: transactionFilter === tx ? 'var(--ink)' : 'transparent',
                            color: transactionFilter === tx ? '#fff' : 'var(--ash)',
                        }}
                    >
                        {tx === 'all' ? t.filterAllTransactions : TRANSACTION_CONFIG[tx].label[lang]}
                    </button>
                ))}
            </div>

            <div style={{ display: 'flex', gap: 3, background: '#fff', border: '1px solid var(--ice)', borderRadius: 12, padding: 4, marginBottom: 20, flexWrap: 'wrap', width: 'fit-content' }}>
                {types.map((type) => (
                    <button
                        key={type}
                        onClick={() => setTypeFilter(type)}
                        style={{
                            padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600,
                            cursor: 'pointer', background: typeFilter === type ? 'var(--ink)' : 'transparent',
                            color: typeFilter === type ? '#fff' : 'var(--ash)',
                        }}
                    >
                        {type === 'all' ? t.all : t.typeLabels[type]}
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
                    fontSize: 13, outline: 'none', width: 260, marginBottom: 20, color: 'var(--ink)',
                }}
            />

            {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{error}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
                {loading && [1, 2, 3, 4, 5, 6].map((i) => <SkeletonCard key={i} />)}
                {!loading && filtered.map((property) => (
                    <PropertyCard
                        key={property.id}
                        property={property}
                        onPhotosChanged={handlePhotosChanged}
                        onVideoChanged={handleVideoChanged}
                        onDeleted={handlePropertyDeleted}
                        onListingStatusChanged={handleListingStatusChanged}
                        onEnlarge={(items, index) => setGallery({ items, startIndex: index })}
                        t={t}
                        lang={lang}
                    />
                ))}
            </div>

            {!loading && filtered.length === 0 && (
                <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>🏚️</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{t.emptyFilter}</div>
                </div>
            )}

            <Lightbox gallery={gallery} onClose={() => setGallery(null)} />
        </div>
    );
}
