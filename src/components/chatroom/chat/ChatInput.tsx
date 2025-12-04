"use client";

import { ModelSelector } from "./ModelSelector";

export function ChatInput() {
  return (
    <div className="mx-auto">
      <fieldset className="flex w-full min-w-0 flex-col">
        <div className="!box-content flex flex-col bg-bg-000 mx-2 md:mx-0 items-stretch transition-all duration-200 relative cursor-text z-10 rounded-2xl border border-transparent shadow-[0_0.25rem_1.25rem_hsl(var(--always-black)/3.5%),0_0_0_0.5px_hsla(var(--border-300)/0.15)] hover:shadow-[0_0.25rem_1.25rem_hsl(var(--always-black)/3.5%),0_0_0_0.5px_hsla(var(--border-200)/0.3)] focus-within:shadow-[0_0.25rem_1.25rem_hsl(var(--always-black)/7.5%),0_0_0_0.5px_hsla(var(--border-200)/0.3)] hover:focus-within:shadow-[0_0.25rem_1.25rem_hsl(var(--always-black)/7.5%),0_0_0_0.5px_hsla(var(--border-200)/0.3)]">
          <div className="flex flex-col gap-3.5 m-3.5">
            <div className="relative">
              <div className="max-h-96 w-full overflow-y-auto font-large break-words transition-opacity duration-200 min-h-12">
                <div
                  contentEditable
                  suppressContentEditableWarning
                  translate="no"
                  role="textbox"
                  aria-label="Write instructions the AI Model"
                  aria-multiline="true"
                  className="font-ui outline-none empty:before:content-[attr(data-placeholder)] empty:before:!text-text-500 empty:before:whitespace-nowrap"
                  data-placeholder="How can I help you today?"
                />
              </div>
            </div>

            <div className="flex gap-2.5 w-full items-center">
              <div className="relative flex-1 flex items-center gap-2 shrink min-w-0">
                {/* Plus button */}
                <div className="relative shrink-0">
                  <button
                    className="border-0.5 transition-all h-8 flex items-center group !pointer-events-auto !outline-offset-1 overflow-hidden px-1.5 min-w-8 rounded-lg justify-center text-text-300 hover:text-text-200/90 hover:bg-bg-100 active:scale-[0.98]"
                    type="button"
                    aria-label="Abrir menu de anexos"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      fill="currentColor"
                      viewBox="0 0 256 256"
                    >
                      <path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />
                    </svg>
                  </button>
                </div>

                {/* Tools button */}
                <div className="relative shrink-0">
                  <button
                    className="border-0.5 transition-all h-8 flex items-center group !pointer-events-auto !outline-offset-1 overflow-hidden px-1.5 min-w-8 rounded-lg justify-center text-text-300 hover:text-text-200/90 hover:bg-bg-100 active:scale-[0.98]"
                    type="button"
                    aria-label="Abrir menu de ferramentas"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      fill="currentColor"
                      viewBox="0 0 256 256"
                    >
                      <path d="M40,88H73a32,32,0,0,0,62,0h81a8,8,0,0,0,0-16H135a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16Zm64-24A16,16,0,1,1,88,80,16,16,0,0,1,104,64ZM216,168H199a32,32,0,0,0-62,0H40a8,8,0,0,0,0,16h97a32,32,0,0,0,62,0h17a8,8,0,0,0,0-16Zm-48,24a16,16,0,1,1,16-16A16,16,0,0,1,168,192Z" />
                    </svg>
                  </button>
                </div>

                {/* Clock button */}
                <div className="flex shrink min-w-8 !shrink-0">
                  <button className="border-0.5 transition-all h-8 flex items-center group !pointer-events-auto !outline-offset-1 overflow-hidden px-1.5 min-w-8 rounded-lg justify-center text-text-300 hover:text-text-200/90 hover:bg-bg-100 active:scale-[0.98]">
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      xmlns="http://www.w3.org/2000/svg"
                      className="shrink-0"
                      aria-hidden="true"
                    >
                      <path d="M10.3857 2.50977C14.3486 2.71054 17.5 5.98724 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 9.72386 2.72386 9.5 3 9.5C3.27614 9.5 3.5 9.72386 3.5 10C3.5 13.5899 6.41015 16.5 10 16.5C13.5899 16.5 16.5 13.5899 16.5 10C16.5 6.5225 13.7691 3.68312 10.335 3.50879L10 3.5L9.89941 3.49023C9.67145 3.44371 9.5 3.24171 9.5 3C9.5 2.72386 9.72386 2.5 10 2.5L10.3857 2.50977ZM10 5.5C10.2761 5.5 10.5 5.72386 10.5 6V9.69043L13.2236 11.0527C13.4706 11.1762 13.5708 11.4766 13.4473 11.7236C13.3392 11.9397 13.0957 12.0435 12.8711 11.9834L12.7764 11.9473L9.77637 10.4473C9.60698 10.3626 9.5 10.1894 9.5 10V6C9.5 5.72386 9.72386 5.5 10 5.5ZM3.66211 6.94141C4.0273 6.94159 4.32303 7.23735 4.32324 7.60254C4.32324 7.96791 4.02743 8.26446 3.66211 8.26465C3.29663 8.26465 3 7.96802 3 7.60254C3.00021 7.23723 3.29676 6.94141 3.66211 6.94141ZM4.95605 4.29395C5.32146 4.29404 5.61719 4.59063 5.61719 4.95605C5.6171 5.3214 5.3214 5.61709 4.95605 5.61719C4.59063 5.61719 4.29403 5.32146 4.29395 4.95605C4.29395 4.59057 4.59057 4.29395 4.95605 4.29395ZM7.60254 3C7.96802 3 8.26465 3.29663 8.26465 3.66211C8.26446 4.02743 7.96791 4.32324 7.60254 4.32324C7.23736 4.32302 6.94159 4.0273 6.94141 3.66211C6.94141 3.29676 7.23724 3.00022 7.60254 3Z" />
                    </svg>
                  </button>
                </div>
              </div>

              <ModelSelector />

              <div style={{ opacity: 1, transform: "none" }}>
                <button
                  className="inline-flex items-center justify-center bg-accent-main-000 text-white h-8 w-8 rounded-md active:scale-95 !rounded-lg !h-8 !w-8"
                  disabled
                  type="button"
                  aria-label="Enviar mensagem"
                >
                  <svg
                    width="16"
                    height="16"
                    fill="currentColor"
                    viewBox="0 0 256 256"
                  >
                    <path d="M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
