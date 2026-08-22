'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getToken, clearToken } from '../../lib/api';
import { useDashboardLanguage } from '../../lib/useDashboardLanguage';
import { dashboardStrings } from '../../lib/dashboardStrings';
import { LanguageToggle } from '../../components/LanguageToggle';
import NotificationBell from '../../components/NotificationBell';

export default function DashboardLayout({ children }) {
    const router = useRouter();
    const pathname = usePathname();
    const [checked, setChecked] = useState(false);
    const [lang, setLang] = useDashboardLanguage();
    const t = dashboardStrings[lang].layout;

    const navItems = [
        { label: t.navLeads, href: '/dashboard', icon: '👥' },
        { label: t.navProperties, href: '/dashboard/properties', icon: '🏠' },
        { label: t.navAppointments, href: '/dashboard/appointments', icon: '📅' },
    ];

    // The backend's authenticateAdmin middleware is the real security
    // boundary — this is only a UX guard so the dashboard doesn't flash
    // empty/broken content before an API call would 401 anyway.
    useEffect(() => {
        if (!getToken()) {
            router.replace('/login');
            return;
        }
        setChecked(true);
    }, [router]);

    const handleLogout = () => {
        clearToken();
        router.push('/login');
    };

    if (!checked) {
        return null;
    }

    return (
        <div style={{ minHeight: '100vh', background: 'var(--canvas)' }}>
            <nav style={{
                position: 'sticky', top: 0, zIndex: 100, height: 60,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '0 28px', background: '#fff', borderBottom: '1px solid var(--ice)',
            }}>
                <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1, color: 'var(--ink)' }}>
                    EXCELIA
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <NotificationBell t={t} lang={lang} />
                    <LanguageToggle lang={lang} setLang={setLang} />
                    <button
                        onClick={handleLogout}
                        style={{
                            padding: '7px 14px', fontSize: 12, fontWeight: 600,
                            background: 'var(--mist)', color: 'var(--ash)',
                            border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)',
                            cursor: 'pointer',
                        }}
                    >
                        {t.logout}
                    </button>
                </div>
            </nav>

            <div style={{ display: 'flex', maxWidth: 1280, margin: '0 auto', minHeight: 'calc(100vh - 60px)' }}>
                <aside style={{
                    width: 200, flexShrink: 0, background: '#fff',
                    borderRight: '1px solid var(--ice)', padding: '20px 12px',
                    position: 'sticky', top: 60, height: 'calc(100vh - 60px)',
                }}>
                    {navItems.map((item) => {
                        const active = item.href === '/dashboard'
                            ? pathname === '/dashboard'
                            : pathname.startsWith(item.href);
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    padding: '10px 12px', borderRadius: 'var(--r-nav)',
                                    marginBottom: 2, textDecoration: 'none',
                                    background: active ? 'var(--ink)' : 'transparent',
                                    color: active ? '#fff' : 'var(--ash)',
                                    fontSize: 13, fontWeight: active ? 700 : 500,
                                }}
                            >
                                <span>{item.icon}</span>
                                <span>{item.label}</span>
                            </Link>
                        );
                    })}
                </aside>

                <main style={{ flex: 1, padding: '28px 32px', minWidth: 0 }}>
                    {children}
                </main>
            </div>
        </div>
    );
}
