import type { Metadata } from 'next';
import './globals.css';
import { tiemposHeadline, styreneA, styreneB, claudeResponse } from './fonts';
import { SidebarProvider } from '@/lib/contexts/SidebarContext';

export const metadata: Metadata = {
    title: 'Claude',
    description: 'Talk with Claude, an AI assistant from Anthropic',
};

export default function RootLayout({
                                       children,
                                   }: {
    children: React.ReactNode;
}) {
    return (
        <html
            lang="pt-BR"
            className={`h-screen antialiased scroll-smooth ${tiemposHeadline.variable} ${styreneA.variable} ${styreneB.variable} ${claudeResponse.variable}`}
            data-theme="claude"
            data-mode="dark"
        >
        <body className="bg-bg-100 text-text-100 font-ui min-h-screen">
        <SidebarProvider>
            {children}
        </SidebarProvider>
        </body>
        </html>
    );
}