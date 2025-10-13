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
                className="inline-flex items-center justify-center h-8 rounded-md min-w-[112px] active:scale-[0.985] whitespace-nowrap text-xs pl-2.5 pr-2 gap-1 text-text-300 bg-bg-300 hover:text-text-100 transition-colors"
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
                        className="absolute top-full right-0 mt-2 bg-bg-300 border border-border-300 rounded-xl shadow-lg overflow-visible z-50 p-[6px]"
                        style={{ width: '418px', minWidth: '128px' }}
                        role="menu"
                        aria-label="Selecionar modelo"
                    >
                        <div>
                            {MODELS.map((model) => (
                                <button
                                    key={model.id}
                                    className="w-full text-left hover:bg-bg-200 transition-colors rounded-lg grid items-center gap-2"
                                    style={{ padding: '6px 4px 6px 8px', fontSize: '14px', lineHeight: '19.6px' }}
                                    onClick={() => handleSelectModel(model)}
                                    role="menuitem"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <div className="font-ui" style={{ fontSize: '14px', lineHeight: '19.6px', color: 'rgb(194, 192, 182)' }}>
                                                {model.name}
                                            </div>
                                            <div className="font-ui" style={{ fontSize: '12px', lineHeight: '16px', color: 'rgb(156, 154, 146)' }}>
                                                {model.description}
                                            </div>
                                            {model.usageInfo && (
                                                <div className="font-ui" style={{ fontSize: '12px', lineHeight: '16px', color: 'rgb(156, 154, 146)' }}>
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
                                    className="w-full text-left hover:bg-bg-200 transition-colors rounded-lg grid items-center gap-2"
                                    style={{ padding: '6px 8px', fontSize: '14px', lineHeight: '20px' }}
                                    onMouseEnter={() => setIsSubmenuOpen(true)}
                                    role="menuitem"
                                    aria-haspopup="menu"
                                    aria-expanded={isSubmenuOpen}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="font-ui" style={{ fontSize: '14px', lineHeight: '20px', color: 'rgb(194, 192, 182)' }}>
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
                                        className="absolute left-full top-0 ml-1 border bg-bg-300 border-border-300 rounded-xl shadow-lg overflow-hidden p-1"
                                        style={{ width: '242px' }}
                                        role="menu"
                                        aria-label="Mais modelos"
                                        onMouseLeave={() => setIsSubmenuOpen(false)}
                                    >
                                        <div>
                                            {OVERFLOW_MODELS.map((model) => (
                                                <button
                                                    key={model.id}
                                                    className="w-full text-left hover:bg-bg-200 transition-colors rounded-lg grid items-center gap-2"
                                                    style={{ padding: '6px 4px 6px 8px', fontSize: '14px', lineHeight: '19.6px' }}
                                                    onClick={() => handleSelectModel(model)}
                                                    role="menuitem"
                                                >
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className="font-ui font-medium" style={{ fontSize: '14px', lineHeight: '20px', color: 'rgb(194, 192, 182)' }}>
                                                                    {model.name}
                                                                </span>
                                                                {model.badge && (
                                                                    <span className="uppercase bg-accent-pro-100/10 text-accent-pro-000 rounded-full px-2 -mr-1 border-0.5 border-accent-pro-100/10 leading-4 h-4 text-[0.6rem] flex-shrink-0" style={{ fontSize: '9.6px', backgroundColor: 'rgba(108, 91, 185, 0.1)', color: 'rgb(155, 135, 245)', padding: '0px 8px', borderRadius: '9999px', border: '1px solid rgba(108, 91, 185, 0.1)' }}>
                                                                        {model.badge}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            {model.description && (
                                                                <div className="font-ui" style={{ fontSize: '12px', lineHeight: '16px', color: 'rgb(156, 154, 146)', marginTop: '2px' }}>
                                                                    {model.description}
                                                                </div>
                                                            )}
                                                            {model.usageInfo && (
                                                                <div className="font-ui" style={{ fontSize: '12px', lineHeight: '16px', color: 'rgb(156, 154, 146)', marginTop: '4px' }}>
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