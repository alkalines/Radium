'use client';

import { useState } from 'react';

export function CookieBanner() {
    const [isVisible, setIsVisible] = useState(true);

    if (!isVisible) return null;

    return (
        <div
            data-theme="claude"
            data-mode="dark"
            data-testid="consent-banner"
            className="fixed right-2 bottom-2 z-toast max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] sm:max-w-md rounded-3xl font-ui bg-bg-500 p-4 sm:p-8 overflow-auto"
        >
            <h3 className="text-xl col-span-2 mb-2 sm:mb-4 text-text-000">
                Configurações de cookies
            </h3>

            <p className="text-sm text-text-300 mb-4">
                Utilizamos cookies para fornecer e melhorar nossos serviços, analisar o uso do site e,
                se você concordar, personalizar sua experiência e divulgar nossos serviços para você.
                Você pode ler nossa Política de Cookies{' '}
                <a className="underline" href="https://www.anthropic.com/legal/cookies">
                    aqui
                </a>
                .
            </p>

            <div className="flex grid-cols-3 grid-rows-1 justify-between gap-2 pb-1 sm:grid sm:grid-cols-2 sm:grid-rows-2 sm:pb-0">
                <button
                    className="inline-flex items-center justify-center h-11 rounded-xl px-5 min-w-24 active:scale-[0.985] whitespace-nowrap !text-base col-span-1 grow sm:col-span-2 text-text-000 border-0.5 border-border-200 bg-bg-300/0 hover:bg-bg-400"
                    type="button"
                    onClick={() => setIsVisible(false)}
                >
                    <span className="sm:hidden">Personalizar</span>
                    <span className="hidden sm:inline">Personalizar Configurações de Cookies</span>
                </button>

                <button
                    className="inline-flex items-center justify-center h-11 rounded-xl px-5 min-w-24 active:scale-[0.985] whitespace-nowrap !text-base col-span-1 grow sm:col-span-1 text-text-000 border-0.5 border-border-200 bg-bg-300/0 hover:bg-bg-400"
                    type="button"
                    onClick={() => setIsVisible(false)}
                >
                    <span className="sm:hidden">Rejeitar</span>
                    <span className="hidden sm:inline">Rejeitar Todos os Cookies</span>
                </button>

                <button
                    className="inline-flex items-center justify-center h-11 rounded-xl px-5 min-w-24 active:scale-[0.985] whitespace-nowrap !text-base col-span-1 grow sm:col-span-1 bg-text-000 text-bg-000 hover:scale-y-[1.015] hover:scale-x-[1.005]"
                    type="button"
                    onClick={() => setIsVisible(false)}
                >
                    <span className="sm:hidden">Aceitar</span>
                    <span className="hidden sm:inline">Aceitar Todos os Cookies</span>
                </button>
            </div>
        </div>
    );
}