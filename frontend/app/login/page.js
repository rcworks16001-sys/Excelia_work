'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { setToken } from '../../lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export default function LoginPage() {
    const router = useRouter();
    const [token, setTokenInput] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!token.trim()) {
            setError('Enter your admin token.');
            return;
        }

        setLoading(true);
        try {
            // Validate the token against a real protected endpoint before
            // storing it — the cookie isn't set yet, so pass it manually.
            await axios.get(`${API_URL}/api/properties`, {
                headers: { Authorization: `Bearer ${token.trim()}` },
            });
            setToken(token.trim());
            router.push('/dashboard');
        } catch (err) {
            if (err.response?.status === 401) {
                setError('Invalid token.');
            } else {
                setError('Could not reach the server. Please try again.');
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--canvas)', padding: 20,
        }}>
            <form onSubmit={handleSubmit} style={{
                width: '100%', maxWidth: 380, background: '#fff',
                border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                padding: 36,
            }}>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: 1, color: 'var(--ink)', marginBottom: 4 }}>
                    EXCELIA
                </div>
                <div style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 28 }}>
                    Admin dashboard
                </div>

                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--ash)', marginBottom: 6 }}>
                    Admin token
                </label>
                <input
                    type="password"
                    value={token}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder="Paste your ADMIN_TOKEN"
                    autoFocus
                    style={{
                        width: '100%', padding: '11px 14px', fontSize: 14,
                        border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)',
                        outline: 'none', marginBottom: 16, color: 'var(--ink)',
                    }}
                />

                {error && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginBottom: 16 }}>
                        {error}
                    </div>
                )}

                <button
                    type="submit"
                    disabled={loading}
                    style={{
                        width: '100%', padding: '12px', fontSize: 13, fontWeight: 700,
                        background: 'var(--ink)', color: '#fff', border: 'none',
                        borderRadius: 'var(--r-btn)', cursor: loading ? 'default' : 'pointer',
                        opacity: loading ? 0.6 : 1,
                    }}
                >
                    {loading ? 'Checking…' : 'Sign in'}
                </button>
            </form>
        </div>
    );
}
