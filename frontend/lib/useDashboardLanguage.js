'use client';

import { useState, useEffect, useCallback } from 'react';

// Dashboard UI-chrome language preference — a toggle for whoever is
// OPERATING the admin panel, completely separate from the bot's own
// per-lead bilingual conversation logic (backend/src/utils/language.js),
// which is untouched by this. Plain localStorage, no Context provider —
// keeping this simple per the client's own instruction, not a full i18n
// framework.
const STORAGE_KEY = 'excelia_dashboard_lang';
const DEFAULT_LANG = 'fr'; // matches the bot's own default — Togo is Francophone

// Module-level subscriber set, shared by every component that calls this
// hook. Without this, each call site only ever reads localStorage once on
// its own mount — toggling the language in one component (e.g. the nav bar)
// would silently NOT update a sibling component's already-rendered strings
// until a full page reload. Broadcasting on every setLang() keeps every
// currently-mounted instance in sync immediately, with no Context/Provider
// wrapping required.
const listeners = new Set();

const readStoredLang = () => {
    if (typeof window === 'undefined') return DEFAULT_LANG;
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'fr' || stored === 'en' ? stored : DEFAULT_LANG;
};

export function useDashboardLanguage() {
    const [lang, setLangState] = useState(DEFAULT_LANG);

    useEffect(() => {
        setLangState(readStoredLang());
        listeners.add(setLangState);
        return () => listeners.delete(setLangState);
    }, []);

    const setLang = useCallback((next) => {
        localStorage.setItem(STORAGE_KEY, next);
        listeners.forEach((listener) => listener(next));
    }, []);

    return [lang, setLang];
}
