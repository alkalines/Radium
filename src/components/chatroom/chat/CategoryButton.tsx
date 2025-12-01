interface CategoryButtonProps {
    label: string;
    icon: React.ReactNode;
    isActive?: boolean;
    onClick?: () => void;
    isFullWidth?: boolean;
}

export function CategoryButton({ label, icon, isActive = false, onClick, isFullWidth = false }: CategoryButtonProps) {
    return (
        <li className={isFullWidth ? "basis-full flex justify-center" : "inline-block"} role="presentation" style={{ opacity: 1, transform: 'none' }}>
            <button
                className="active:scale-[0.995] border-0.5 border-border-300 bg-bg-100 cursor-pointer ease-in-out group will-change-transform hover:bg-bg-000 line-clamp-1 overflow-hidden relative rounded-lg text-sm text-text-200 font-base px-2.5 h-8 transition-all"
                role="tab"
                aria-selected={isActive}
                onClick={onClick}
            >
                <div className="flex items-center gap-1.5">
                    <span className="text-text-300 group-hover:text-text-200 -ml-0.5">{icon}</span>
                    <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
                </div>
            </button>
        </li>
    );
}