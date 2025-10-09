import { cn } from '@/lib/utils';
import { ButtonHTMLAttributes, forwardRef } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'ghost' | 'primary' | 'secondary';
    size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = 'ghost', size = 'md', children, ...props }, ref) => {
        const baseStyles =
            'inline-flex items-center justify-center relative shrink-0 select-none disabled:pointer-events-none disabled:opacity-50 transition';

        const variants = {
            ghost: 'text-text-300 border-transparent hover:bg-bg-300 hover:text-text-100',
            primary: 'bg-accent-main-000 text-white hover:bg-accent-main-200',
            secondary: 'border-0.5 border-border-300 hover:border-bg-300 bg-bg-100 hover:bg-bg-300',
        };

        const sizes = {
            sm: 'h-8 w-8 rounded-md',
            md: 'h-9 px-4 py-2 rounded-lg min-w-20',
            lg: 'h-11 rounded-xl px-5 min-w-24',
        };

        return (
            <button
                ref={ref}
                className={cn(
                    baseStyles,
                    variants[variant],
                    sizes[size],
                    'active:scale-95',
                    className
                )}
                {...props}
            >
                {children}
            </button>
        );
    }
);

Button.displayName = 'Button';