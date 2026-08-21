'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../../../lib/api';
import { useDashboardLanguage } from '../../../lib/useDashboardLanguage';
import { dashboardStrings } from '../../../lib/dashboardStrings';

const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
};

function PropertyCard({ property, onPhotosChanged, t, lang }) {
    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState('');
    const photos = property.photos || [];
    const hasPhoto = photos.length > 0;
    // description is authored in French; description_en is the cached one-time
    // translation. Falls back to French if this listing hasn't been translated
    // yet (run `npm run backfill-translations` in backend/ to fill new ones).
    const description = lang === 'en' ? (property.description_en || property.description) : property.description;

    const handleFileChange = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow picking the same file again later
        if (!file) return;

        setUploadError('');
        setUploading(true);
        try {
            const formData = new FormData();
            formData.append('photo', file);
            const response = await api.post(`/properties/${property.id}/photos`, formData);
            onPhotosChanged(property.id, response.data.photos);
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

    return (
        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
            {/* Cover photo, or a clear placeholder if none uploaded yet. */}
            <div style={{
                height: 140, background: 'var(--mist)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4, position: 'relative',
            }}>
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
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>
                    {t.typeLabels[property.type] || property.type}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fog)', marginBottom: 10 }}>
                    {property.neighbourhood}, {property.city}
                    {property.bedrooms ? ` · ${property.bedrooms} ${t.bedroomsAbbrev}` : ''}
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>{formatXOF(property.price)}</div>
                {description && (
                    <p style={{ fontSize: 12, color: 'var(--ash)', lineHeight: 1.5, marginBottom: 8 }}>
                        {description}
                    </p>
                )}

                {/* Photo thumbnails — each removable */}
                {hasPhoto && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                        {photos.map((url) => (
                            <div key={url} style={{ position: 'relative', width: 44, height: 44 }}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={url} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--ice)' }} />
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
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                />
                <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    style={{
                        fontSize: 11, fontWeight: 600, padding: '6px 12px', borderRadius: 'var(--r-btn)',
                        border: '1px solid var(--ice)', background: 'var(--mist)', color: 'var(--ash)',
                        cursor: uploading ? 'default' : 'pointer', marginBottom: 8,
                    }}
                >
                    {uploading ? t.uploading : t.uploadPhoto}
                </button>
                {uploadError && <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 8 }}>{uploadError}</div>}

                <div style={{ fontSize: 11, color: 'var(--fog)', borderTop: '1px solid var(--ice)', paddingTop: 8 }}>
                    {property.agency_contact}
                </div>
            </div>
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

export default function PropertiesPage() {
    const router = useRouter();
    const [properties, setProperties] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [typeFilter, setTypeFilter] = useState('all');
    const [search, setSearch] = useState('');
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

    const types = ['all', ...Object.keys(t.typeLabels)];
    const filtered = properties.filter((p) => {
        if (typeFilter !== 'all' && p.type !== typeFilter) return false;
        if (!search) return true;
        const q = search.toLowerCase();
        return (p.neighbourhood || '').toLowerCase().includes(q)
            || (p.city || '').toLowerCase().includes(q)
            || (p.description || '').toLowerCase().includes(q)
            || (p.description_en || '').toLowerCase().includes(q);
    });

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>{t.heading}</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 20 }}>
                {loading ? t.loading : t.listingsCount(properties.length)}
            </p>

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
                    <PropertyCard key={property.id} property={property} onPhotosChanged={handlePhotosChanged} t={t} lang={lang} />
                ))}
            </div>

            {!loading && filtered.length === 0 && (
                <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>🏚️</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{t.emptyFilter}</div>
                </div>
            )}
        </div>
    );
}
