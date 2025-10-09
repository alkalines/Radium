import Link from 'next/link';
import { cn } from '@/lib/utils';

interface SidebarItemProps {
    href: string;
    icon: React.ReactNode;
    label: string;
    isActive?: boolean;
}

export function SidebarItem({ href, icon, label, isActive = false }: SidebarItemProps) {
    return (
        <div className="relative group" data-state="closed">
            <Link
                href={href}
                className={cn(
                    'inline-flex items-center justify-center relative shrink-0 select-none',
                    'text-text-300 border-transparent transition font-base',
                    'hover:bg-bg-300 hover:text-text-100',
                    'h-9 px-4 py-2 rounded-lg min-w-20 active:scale-[0.985]',
                    'w-full hover:bg-bg-400 overflow-hidden !min-w-0 group',
                    'active:bg-bg-400 active:scale-100 px-4',
                    isActive && 'bg-bg-400 text-text-100'
                )}
                aria-label={label}
            >
                <div className="-translate-x-2 w-full flex flex-row items-center justify-start gap-3">
                    <div className="size-4 flex items-center justify-center">{icon}</div>
                    <span className="truncate text-sm whitespace-nowrap w-full">
            <div className="transition-all duration-200">{label}</div>
          </span>
                </div>
            </Link>
        </div>
    );
}