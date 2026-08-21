'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '../../../lib/api';

const formatXOF = (amount) => {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n)) return '';
    return `${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F CFA`;
};

const TYPE_LABELS = {
    chambre_salon: 'Chambre salon',
    appartement: 'Appartement',
    villa: 'Villa',
    terrain: 'Terrain',
    mini_villa: 'Mini-villa',
    appartement_meuble: 'Appartement meublé',
};

function PropertyCard({ property }) {
    const hasPhoto = property.photos && property.photos.length > 0;
    return (
        <div style={{ background: '#fff', border: '1px solid var(--ice)', borderRadius: 'var(--r-card)', overflow: 'hidden' }}>
            {/* No real Cloudinary photos yet (client hasn't sent them) — show a
                clear placeholder rather than a broken <img>. */}
            <div style={{
                height: 140, background: 'var(--mist)', display: 'flex',
                alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4,
            }}>
                {hasPhoto ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={property.photos[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                    <>
                        <span style={{ fontSize: 24 }}>📷</span>
                        <span style={{ fontSize: 11, color: 'var(--fog)' }}>Photos coming soon</span>
                    </>
                )}
            </div>
            <div style={{ padding: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>
                    {TYPE_LABELS[property.type] || property.type}
                </div>
                <div style={{ fontSize: 12, color: 'var(--fog)', marginBottom: 10 }}>
                    {property.neighbourhood}, {property.city}
                    {property.bedrooms ? ` · ${property.bedrooms} ch.` : ''}
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 8 }}>{formatXOF(property.price)}</div>
                {property.description && (
                    <p style={{ fontSize: 12, color: 'var(--ash)', lineHeight: 1.5, marginBottom: 8 }}>
                        {property.description}
                    </p>
                )}
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
                setError('Failed to load properties.');
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    const types = ['all', ...Object.keys(TYPE_LABELS)];
    const filtered = typeFilter === 'all' ? properties : properties.filter((p) => p.type === typeFilter);

    return (
        <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5, marginBottom: 4 }}>Properties</h1>
            <p style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 20 }}>
                {loading ? 'Loading…' : `${properties.length} listings`}
            </p>

            <div style={{ display: 'flex', gap: 3, background: '#fff', border: '1px solid var(--ice)', borderRadius: 12, padding: 4, marginBottom: 20, flexWrap: 'wrap', width: 'fit-content' }}>
                {types.map((t) => (
                    <button
                        key={t}
                        onClick={() => setTypeFilter(t)}
                        style={{
                            padding: '6px 13px', borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600,
                            cursor: 'pointer', background: typeFilter === t ? 'var(--ink)' : 'transparent',
                            color: typeFilter === t ? '#fff' : 'var(--ash)',
                        }}
                    >
                        {t === 'all' ? 'All' : TYPE_LABELS[t]}
                    </button>
                ))}
            </div>

            {error && <div style={{ color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{error}</div>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16 }}>
                {loading && [1, 2, 3, 4, 5, 6].map((i) => <SkeletonCard key={i} />)}
                {!loading && filtered.map((property) => (
                    <PropertyCard key={property.id} property={property} />
                ))}
            </div>

            {!loading && filtered.length === 0 && (
                <div style={{ padding: '56px 20px', textAlign: 'center' }}>
                    <div style={{ fontSize: 32, marginBottom: 10 }}>🏚️</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>No properties for this filter</div>
                </div>
            )}
        </div>
    );
}
