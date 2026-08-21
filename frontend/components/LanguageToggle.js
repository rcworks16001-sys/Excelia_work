'use client';

// Small "FR | EN" pill switch, shared by the dashboard nav (dashboard/layout.js)
// and the login page (which sits outside that layout) — both read/write the
// same lib/useDashboardLanguage() localStorage key, so whichever the admin
// last picked carries over between the two.
export function LanguageToggle({ lang, setLang }) {
    return (
        <div style={{ display: 'flex', gap: 2, background: 'var(--mist)', border: '1px solid var(--ice)', borderRadius: 'var(--r-btn)', padding: 2 }}>
            {['fr', 'en'].map((code) => (
                <button
                    key={code}
                    onClick={() => setLang(code)}
                    style={{
                        padding: '5px 10px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 700,
                        cursor: 'pointer', background: lang === code ? 'var(--ink)' : 'transparent',
                        color: lang === code ? '#fff' : 'var(--ash)',
                    }}
                >
                    {code.toUpperCase()}
                </button>
            ))}
        </div>
    );
}
