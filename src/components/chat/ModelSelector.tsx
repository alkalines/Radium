'use client';

export function ModelSelector() {
    return (
        <div className="overflow-hidden shrink-0 p-1 -m-1" style={{ opacity: 1, transform: 'none' }}>
            <button
                className="inline-flex items-center justify-center h-8 rounded-md px-3 min-w-16 active:scale-[0.985] whitespace-nowrap !text-xs pl-2.5 pr-2 gap-1 text-text-300 hover:bg-bg-300 hover:text-text-100"
                type="button"
                data-testid="model-selector-dropdown"
            >
                <div className="font-claude-response inline-flex gap-[3px] text-sm h-[14px] leading-none items-baseline">
                    <div className="flex items-center gap-1">
                        <div className="whitespace-nowrap select-none">Sonnet 4.5</div>
                    </div>
                </div>

                <div className="flex items-center justify-center opacity-75">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M14.128 7.16482C14.3126 6.95983 14.6298 6.94336 14.835 7.12771C15.0402 7.31242 15.0567 7.62952 14.8721 7.83477L10.372 12.835L10.2939 12.9053C10.2093 12.9667 10.1063 13 9.99995 13C9.85833 12.9999 9.72264 12.9402 9.62788 12.835L5.12778 7.83477L5.0682 7.75273C4.95072 7.55225 4.98544 7.28926 5.16489 7.12771C5.34445 6.96617 5.60969 6.95939 5.79674 7.09744L5.87193 7.16482L9.99995 11.7519L14.128 7.16482Z" />
                    </svg>
                </div>
            </button>
        </div>
    );
}