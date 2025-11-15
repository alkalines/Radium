'use client';

import { useState, useEffect } from 'react';

const COOKIE_NAME = 'anthropic-consent-preferences';

interface ConsentPreferences {
    analytics: boolean;
    marketing: boolean;
}

function setConsentCookie(preferences: ConsentPreferences): void {
    if (typeof document === 'undefined') return;
    
    const value = encodeURIComponent(JSON.stringify(preferences));
    const maxAge = 31536000; // 1 year in seconds
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    
    document.cookie = `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

function readConsentCookie(): ConsentPreferences | null {
    if (typeof document === 'undefined') return null;
    
    try {
        const cookies = document.cookie.split('; ');
        const consentCookie = cookies.find(row => row.startsWith(`${COOKIE_NAME}=`));
        
        if (!consentCookie) return null;
        
        const value = consentCookie.split('=')[1];
        const decoded = decodeURIComponent(value);
        const parsed = JSON.parse(decoded) as ConsentPreferences;
        
        return parsed;
    } catch (error) {
        console.debug('Failed to read consent cookie:', error);
        return null;
    }
}

export function CookieBanner() {
    const [isVisible, setIsVisible] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        if (typeof document !== 'undefined') {
            const existingConsent = readConsentCookie();
            setIsVisible(!existingConsent);
        }
    }, []);

    const handleAccept = () => {
        setConsentCookie({ analytics: true, marketing: true });
        setIsVisible(false);
    };

    const handleReject = () => {
        setConsentCookie({ analytics: false, marketing: false });
        setIsVisible(false);
    };

    const handleCustomize = () => {
        console.debug('Cookie customization panel - placeholder for future implementation');
        // Placeholder: não abre painel por ora
    };

    if (!mounted || !isVisible) return null;

    return (
        <div
            data-theme="claude"
            data-mode="dark"
            data-testid="consent-banner"
            aria-live="polite"
            style={{
                position: 'fixed',
                bottom: '8px',
                right: '8px',
                backgroundColor: 'rgb(0, 0, 0)',
                borderRadius: '24px',
                padding: '32px',
                width: '448px',
                zIndex: 60,
                color: 'rgb(250, 249, 245)',
            }}
        >
            <h3
                style={{
                    fontSize: '20px',
                    fontWeight: 400,
                    lineHeight: '28px',
                    color: 'rgb(250, 249, 245)',
                    marginBottom: '16px',
                }}
            >
                Configurações de cookies
            </h3>

            <p
                style={{
                    fontSize: '16px',
                    fontWeight: 400,
                    lineHeight: '22.4px',
                    color: 'rgb(250, 249, 245)',
                    marginBottom: '16px',
                }}
            >
                Utilizamos cookies para fornecer e melhorar nossos serviços, analisar o uso do site e,
                se você concordar, personalizar sua experiência e divulgar nossos serviços para você.
                Você pode ler nossa Política de Cookies{' '}
                <a
                    style={{
                        fontSize: '16px',
                        textDecoration: 'none',
                        color: 'inherit',
                    }}
                    href="https://www.anthropic.com/legal/cookies"
                >
                    aqui
                </a>
                .
            </p>

            <div
                style={{
                    display: 'grid',
                    gap: '8px',
                }}
            >
                <button
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: 'transparent',
                        color: 'rgb(250, 249, 245)',
                        border: '1px solid rgba(222, 220, 209, 0.3)',
                        borderRadius: '9.6px',
                        padding: '0 20px',
                        fontSize: '16px',
                        fontWeight: 460,
                        lineHeight: '24px',
                        height: '44px',
                        width: '100%',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                    }}
                    type="button"
                    onClick={handleCustomize}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(222, 220, 209, 0.1)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                >
                    Personalizar Configurações de Cookies
                </button>

                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '8px',
                    }}
                >
                    <button
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'transparent',
                            color: 'rgb(250, 249, 245)',
                            border: '1px solid rgba(222, 220, 209, 0.3)',
                            borderRadius: '9.6px',
                            padding: '0 20px',
                            fontSize: '16px',
                            fontWeight: 460,
                            lineHeight: '24px',
                            height: '44px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                        }}
                        type="button"
                        onClick={handleReject}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgba(222, 220, 209, 0.1)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                    >
                        Rejeitar Todos os Cookies
                    </button>

                    <button
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgb(250, 249, 245)',
                            color: 'rgb(48, 48, 46)',
                            border: 'none',
                            borderRadius: '9.6px',
                            padding: '0 20px',
                            fontSize: '16px',
                            fontWeight: 460,
                            lineHeight: '24px',
                            height: '44px',
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                        }}
                        type="button"
                        onClick={handleAccept}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgb(230, 229, 225)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgb(250, 249, 245)';
                        }}
                    >
                        Aceitar Todos os Cookies
                    </button>
                </div>
            </div>
        </div>
    );
}