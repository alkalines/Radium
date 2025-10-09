interface IconProps {
    children: React.ReactNode;
    size?: number;
    className?: string;
}

export function Icon({ children, size = 20, className = '' }: IconProps) {
    return (
        <div
            className={`flex items-center justify-center ${className}`}
            style={{ width: `${size}px`, height: `${size}px` }}
        >
            {children}
        </div>
    );
}