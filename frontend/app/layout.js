import './globals.css';

// Root layout for the EXCELIA admin dashboard — wraps every page in app/.

export const metadata = {
    title: 'EXCELIA — Admin',
    description: 'EXCELIA real estate dashboard',
};

export default function RootLayout({ children }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
