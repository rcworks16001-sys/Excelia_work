import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
const COOKIE_NAME = 'excelia_token';

// ── Token cookie helpers ──
// Plain client-side cookie by design — EXCELIA's auth model is a single
// shared admin token, not a per-user session (see CLAUDE.md's Authentication
// section). Never store secrets beyond this one token in the frontend.
export const getToken = () => {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
};

export const setToken = (token) => {
    if (typeof document === 'undefined') return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`;
};

export const clearToken = () => {
    if (typeof document === 'undefined') return;
    document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
};

// ── Axios instance ──
// Reads the token from the cookie and attaches it as Authorization: Bearer
// on every request — the backend's authenticateAdmin middleware is the real
// security boundary; this is just how the frontend supplies the token.
const api = axios.create({
    baseURL: `${API_URL}/api`,
});

api.interceptors.request.use((config) => {
    const token = getToken();
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

export default api;
