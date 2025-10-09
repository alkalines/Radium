'use client';

import { ModelSelector } from './ModelSelector';

export function ChatInput() {
    return (
        <div className="top-5 z-10 mx-auto w-full max-w-2xl">
            <div className="mx-auto">
                <fieldset className="flex w-full min-w-0 flex-col">
                    <div className="!box-content flex flex-col bg-bg-000 mx-2 md:mx-0 items-stretch transition-all duration-200 relative cursor-text z-10 rounded-2xl border border-transparent shadow-[0_0.25rem_1.25rem_hsl(var(--always-black)/3.5%),0_0_0_0.5px_hsla(var(--border-300)/0.15)] hover:shadow-[0_0.25rem_1.25rem_hsl(var(--always-black)/3.5%),0_0_0_0.5px_hsla(var(--border-200)/0.3)]">
                        <div className="flex flex-col gap-3.5 m-3.5">
                            <div className="relative">
                                <div className="max-h-96 w-full overflow-y-auto font-large break-words transition-opacity duration-200 min-h-12">
                                    <div
                                        contentEditable="true"
                                        translate="no"
                                        role="textbox"
                                        aria-label="Escreva as instruções para o Claude"
                                        aria-multiline="true"
                                        className="ProseMirror outline-none"
                                    >
                                        <p
                                            data-placeholder="Como posso ajudar você hoje?"
                                            className="is-empty is-editor-empty before:!text-text-500 before:whitespace-nowrap"
                                        >
                                            <br className="ProseMirror-trailingBreak" />
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="flex gap-2.5 w-full items-center">
                                <div className="relative flex-1 flex items-center gap-2 shrink min-w-0">
                                    {/* Plus button */}
                                    <div className="relative shrink-0">
                                        <button
                                            className="inline-flex items-center justify-center border-0.5 transition-all h-8 min-w-8 rounded-lg px-[7.5px] text-text-300 border-border-300 active:scale-[0.98] hover:text-text-200/90 hover:bg-bg-100"
                                            type="button"
                                            aria-label="Abrir menu de anexos"
                                        >
                                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                                                <path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />
                                            </svg>
                                        </button>
                                    </div>

                                    {/* Tools button */}
                                    <div className="relative shrink-0">
                                        <button
                                            className="inline-flex items-center justify-center border-0.5 transition-all h-8 min-w-8 rounded-lg px-[7.5px] text-text-300 border-border-300 active:scale-[0.98] hover:text-text-200/90 hover:bg-bg-100"
                                            type="button"
                                            aria-label="Abrir menu de ferramentas"
                                        >
                                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                                                <path d="M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Z" />
                                            </svg>
                                        </button>
                                    </div>

                                    {/* Clock button */}
                                    <div className="flex shrink min-w-8 !shrink-0">
                                        <button className="inline-flex items-center justify-center border-0.5 transition-all h-8 min-w-8 rounded-lg px-[7.5px] text-text-300 border-border-300 active:scale-[0.98] hover:text-text-200/90 hover:bg-bg-100">
                                            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                                                <path d="M10.3857 2.50977C14.3486 2.71054 17.5 5.98724 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 9.72386 2.72386 9.5 3 9.5C3.27614 9.5 3.5 9.72386 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.5225 13.7691 3.68312 10.335 3.50879L10 3.5L9.89941 3.49023C9.67145 3.44371 9.5 3.24171 9.5 3C9.5 2.72386 9.72386 2.5 10 2.5L10.3857 2.50977Z" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>

                                <ModelSelector />

                                <div style={{ opacity: 1, transform: 'none' }}>
                                    <button
                                        className="inline-flex items-center justify-center bg-accent-main-000 text-white h-8 w-8 rounded-md active:scale-95 !rounded-lg !h-8 !w-8"
                                        disabled
                                        type="button"
                                        aria-label="Enviar mensagem"
                                    >
                                        <svg width="16" height="16" fill="currentColor" viewBox="0 0 256 256">
                                            <path d="M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </fieldset>
            </div>
        </div>
    );
}