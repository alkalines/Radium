'use client';

export function ModelSelector() {
    return (
        <div className="overflow-hidden shrink-0 p-1 -m-1" style={{ opacity: 1, transform: 'none' }}>
            <button
                className="inline-flex items-center justify-center h-8 rounded-md px-3 min-w-16 active:scale-[0.985] whitespace-nowrap text-xs pl-2.5 pr-2 gap-1 text-text-300 hover:bg-bg-300 hover:text-text-100"
                type="button"
                data-testid="model-selector-dropdown"
            >
                <div className="font-claude-response inline-flex gap-[3px] text-sm h-[14px] leading-none items-baseline">
                    <div className="flex items-center gap-1">
                        <div className="whitespace-nowrap select-none">Sonnet 4.5</div>
                    </div>
                </div>

                <div className="flex items-center justify-center opacity-75 -mr-1">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor"
                         viewBox="0 0 256 256" className="flex-shrink-0">
                        <path
                            d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>
                    </svg>
                </div>
            </button>
        </div>
    );
}