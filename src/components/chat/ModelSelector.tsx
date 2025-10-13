'use client';

import { useState, useRef, useEffect } from 'react';
import { useModel, MODELS, OVERFLOW_MODELS } from '@/lib/contexts/ModelContext';

export function ModelSelector() {
    const { selectedModel, setSelectedModel } = useModel();
    const [isOpen, setIsOpen] = useState(false);
    const [isSubmenuOpen, setIsSubmenuOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Fechar dropdown ao clicar fora
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
                setIsSubmenuOpen(false);
            }
        }

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    const handleSelectModel = (model: typeof MODELS[0]) => {
        setSelectedModel(model);
        setIsOpen(false);
        setIsSubmenuOpen(false);
        buttonRef.current?.focus();
    };

    const handleToggle = () => {
        setIsOpen(!isOpen);
        setIsSubmenuOpen(false);
    };

    return (
        <div className="relative shrink-0 p-1 -m-1" style={{ opacity: 1, transform: 'none' }} ref={dropdownRef}>
            <button
                ref={buttonRef}
                className="inline-flex items-center justify-center h-8 rounded-md px-3 min-w-16 active:scale-[0.985] whitespace-nowrap text-xs pl-2.5 pr-2 gap-1 text-text-300 hover:bg-bg-300 hover:text-text-100 transition-colors"
                type="button"
                data-testid="model-selector-dropdown"
                onClick={handleToggle}
                aria-expanded={isOpen}
                aria-haspopup="menu"
            >
                <div className="font-ui inline-flex gap-[3px] text-sm h-[14px] leading-none items-baseline">
                    <div className="flex items-center gap-1">
                        <div className="whitespace-nowrap select-none">{selectedModel.name}</div>
                    </div>
                </div>

                <div className="flex items-center justify-center opacity-75 -mr-1">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        fill="currentColor"
                        viewBox="0 0 256 256"
                        className="flex-shrink-0 transition-transform duration-200"
                        style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
                    >
                        <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>
                    </svg>
                </div>
            </button>

            {/* Dropdown Menu */}
            {isOpen && (
                <>
                    <div
                        className="absolute top-full right-0 mt-2 w-80 bg-bg-200 border border-border-300 rounded-lg shadow-lg overflow-visible z-50"
                        role="menu"
                        aria-label="Selecionar modelo"
                    >
                        <div className="py-1">
                            {MODELS.map((model) => (
                                <button
                                    key={model.id}
                                    className="w-full text-left px-4 py-3 hover:bg-bg-300 transition-colors"
                                    onClick={() => handleSelectModel(model)}
                                    role="menuitem"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex-1 min-w-0">
                                            <div className="font-ui text-sm text-text-100 font-medium">
                                                {model.name}
                                            </div>
                                            <div className="font-ui text-xs text-text-300 mt-0.5">
                                                {model.description}
                                            </div>
                                            {model.usageInfo && (
                                                <div className="font-ui text-xs text-text-400 mt-1">
                                                    {model.usageInfo}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex-shrink-0 mt-0.5">
                                            {selectedModel.id === model.id && (
                                                <svg
                                                    width="16"
                                                    height="16"
                                                    viewBox="0 0 16 16"
                                                    fill="currentColor"
                                                    className="text-accent-main-000"
                                                >
                                                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                                                </svg>
                                            )}
                                        </div>
                                    </div>
                                </button>
                            ))}

                            {/* Mais modelos */}
                            <div className="relative">
                                <button
                                    className="w-full text-left px-4 py-3 hover:bg-bg-300 transition-colors border-t border-border-300"
                                    onMouseEnter={() => setIsSubmenuOpen(true)}
                                    role="menuitem"
                                    aria-haspopup="menu"
                                    aria-expanded={isSubmenuOpen}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="font-ui text-sm text-text-100">
                                            Mais modelos
                                        </div>
                                        <svg
                                            width="16"
                                            height="16"
                                            viewBox="0 0 16 16"
                                            fill="currentColor"
                                            className="text-text-300"
                                        >
                                            <path d="M6.22 4.22a.75.75 0 011.06 0l3.25 3.25a.75.75 0 010 1.06l-3.25 3.25a.75.75 0 01-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 010-1.06z"/>
                                        </svg>
                                    </div>
                                </button>

                                {/* Submenu */}
                                {isSubmenuOpen && (
                                    <div
                                        className="absolute left-full top-0 ml-1 w-72 bg-bg-200 border border-border-300 rounded-lg shadow-lg overflow-hidden"
                                        role="menu"
                                        aria-label="Mais modelos"
                                        onMouseLeave={() => setIsSubmenuOpen(false)}
                                    >
                                        <div className="py-1">
                                            {OVERFLOW_MODELS.map((model) => (
                                                <button
                                                    key={model.id}
                                                    className="w-full text-left px-4 py-3 hover:bg-bg-300 transition-colors"
                                                    onClick={() => handleSelectModel(model)}
                                                    role="menuitem"
                                                >
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-ui text-sm text-text-100 font-medium">
                                                                    {model.name}
                                                                </span>
                                                                {model.badge && (
                                                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                                                        {model.badge}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {model.description && (
                                                                <div className="font-ui text-xs text-text-300 mt-0.5">
                                                                    {model.description}
                                                                </div>
                                                            )}
                                                            {model.usageInfo && (
                                                                <div className="font-ui text-xs text-text-400 mt-1">
                                                                    {model.usageInfo}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="flex-shrink-0 mt-0.5">
                                                            {selectedModel.id === model.id && (
                                                                <svg
                                                                    width="16"
                                                                    height="16"
                                                                    viewBox="0 0 16 16"
                                                                    fill="currentColor"
                                                                    className="text-accent-main-000"
                                                                >
                                                                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/>
                                                                </svg>
                                                            )}
                                                        </div>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}