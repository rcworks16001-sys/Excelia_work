import './globals.css';

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
