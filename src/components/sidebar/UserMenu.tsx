export function UserMenu() {
    return (
        <div className="px-2 pb-1 transition">
            <button
                className="inline-flex items-center justify-center h-9 px-4 py-2 rounded-lg min-w-20 active:scale-[0.985] whitespace-nowrap !scale-100 flex flex-row flex-grow items-center pointer-cursor !min-w-0 w-full hover:!bg-bg-400 !transition-all !px-1.5 py-6 gap-3 text-text-300 hover:bg-bg-300 hover:text-text-100"
                type="button"
                data-testid="user-menu-button"
            >
                <div className="flex-shrink-0 flex size-8 items-center justify-center rounded-full text-text-200">
                    <div className="flex shrink-0 items-center justify-center rounded-full font-bold select-none h-7 w-7 text-xs bg-text-200 text-bg-100">
                        GM
                    </div>
                </div>

                <div className="transition-all duration-200 flex w-full text-sm justify-between items-center font-medium min-w-0">
                    <div className="flex flex-col items-start w-full max-w-full overflow-hidden pr-4">
            <span className="w-full max-w-full overflow-hidden text-start block truncate">
              Gabriel Moneiro
            </span>
                        <span className="w-full truncate text-xs text-text-300 font-normal text-start">
              plano Gratuito
            </span>
                    </div>

                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        fill="currentColor"
                        viewBox="0 0 256 256"
                        className="flex-shrink-0 mr-2"
                    >
                        <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
                    </svg>
                </div>
            </button>
        </div>
    );
}