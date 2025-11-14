'use client';

import { useState, useEffect } from 'react';

const CONSENT_KEY = 'cookie-consent';

export function CookieBanner() {
    const [isVisible, setIsVisible] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const consent = localStorage.getItem(CONSENT_KEY);
        if (!consent) {
            setIsVisible(true);
        }
    }, []);

    const handleConsent = (choice: 'accept' | 'reject' | 'customize') => {
        localStorage.setItem(CONSENT_KEY, choice);
        setIsVisible(false);
    };

    if (!mounted || !isVisible) return null;

    return (
        <div
            data-theme="claude"
            data-mode="dark"
            data-testid="consent-banner"
            style={{
                position: 'fixed',
                bottom: '8px',
                right: '8px',
                backgroundColor: 'rgb(0, 0, 0)',
                borderRadius: '24px',
                padding: '32px',
                maxWidth: '448px',
                width: '448px',
                zIndex: 60,
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
                    fontSize: '14px',
                    fontWeight: 400,
                    lineHeight: '20px',
                    color: 'rgb(194, 192, 182)',
                    marginBottom: '16px',
                }}
            >
                Utilizamos cookies para fornecer e melhorar nossos serviços, analisar o uso do site e,
                se você concordar, personalizar sua experiência e divulgar nossos serviços para você.
                Você pode ler nossa Política de Cookies{' '}
                <a
                    style={{
                        textDecoration: 'underline',
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
                    onClick={() => handleConsent('customize')}
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
                        onClick={() => handleConsent('reject')}
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
                        onClick={() => handleConsent('accept')}
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