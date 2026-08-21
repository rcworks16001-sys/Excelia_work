'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { setToken } from '../../lib/api';
import { useDashboardLanguage } from '../../lib/useDashboardLanguage';
import { dashboardStrings } from '../../lib/dashboardStrings';
import { LanguageToggle } from '../../components/LanguageToggle';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

export default function LoginPage() {
    const router = useRouter();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [lang, setLang] = useDashboardLanguage();
    const t = dashboardStrings[lang].login;

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        if (!username.trim() || !password) {
            setError(t.emptyCredentialsError);
            return;
        }

        setLoading(true);
        try {
            const response = await axios.post(`${API_URL}/api/auth/login`, {
                username: username.trim(),
                password,
            });
            setToken(response.data.token);
            router.push('/dashboard');
        } catch (err) {
            if (err.response?.status === 401) {
                setError(t.invalidCredentialsError);
            } else {
                setError(t.genericError);
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--canvas)', padding: 20, position: 'relative',
        }}>
            <div style={{ position: 'absolute', top: 20, right: 20 }}>
                <LanguageToggle lang={lang} setLang={setLang} />
            </div>

            <form onSubmit={handleSubmit} style={{
                width: '100%', maxWidth: 380, background: '#fff',
                border: '1px solid var(--ice)', borderRadius: 'var(--r-card)',
                padding: 36,
            }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src="/logo.jpeg"
                    alt={t.productName}
                    style={{ width: '100%', maxWidth: 220, height: 'auto', display: 'block', marginBottom: 8 }}
                />
                <div style={{ fontSize: 13, color: 'var(--fog)', marginBottom: 28 }}>
                    {t.subtitle}
                </div>

                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--ash)', marginBottom: 6 }}>
                    {t.usernameLabel}
                </label>
                <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t.usernamePlaceholder}
                    autoFocus
                    autoComplete="username"
                    style={{
                        width: '100%', padding: '11px 14px', fontSize: 14,
                        border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)',
                        outline: 'none', marginBottom: 16, color: 'var(--ink)',
                    }}
                />

                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--ash)', marginBottom: 6 }}>
                    {t.passwordLabel}
                </label>
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t.passwordPlaceholder}
                    autoComplete="current-password"
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
                    {loading ? t.checking : t.signIn}
                </button>
            </form>
        </div>
    );
}
