import Link from 'next/link';
import { Conversation } from '@/types';

interface ConversationItemProps {
    conversation: Conversation;
}

export function ConversationItem({ conversation }: ConversationItemProps) {
    const isUntitled = conversation.title === 'Sem título';

    return (
        <li style={{ opacity: 1 }}>
            <div className="relative group" data-state="closed">
                <Link
                    href={conversation.href}
                    className="inline-flex items-center justify-center relative shrink-0 select-none text-text-300 border-transparent transition hover:bg-bg-300 hover:text-text-100 h-8 rounded-md px-3 min-w-16 active:scale-[0.985] whitespace-nowrap !text-xs w-full hover:bg-bg-400 overflow-hidden !min-w-0 group active:bg-bg-400 active:scale-100 px-4"
                >
                    <div className="-translate-x-2 w-full flex flex-row items-center justify-start gap-3">
            <span className="font-ui truncate text-sm whitespace-nowrap w-full group-hover:[mask-image:linear-gradient(to_right,hsl(var(--always-black))_78%,transparent_95%)] [mask-size:100%_100%]">
              <span className={isUntitled ? 'opacity-60' : ''}>{conversation.title}</span>
            </span>
                    </div>
                </Link>

                <div className="absolute right-0 top-1/2 -translate-y-1/2 hidden group-hover:block group-focus-within:block">
                    <button
                        className="inline-flex items-center justify-center h-8 w-8 rounded-md text-text-300 hover:bg-bg-300 hover:text-text-100 active:scale-95"
                        type="button"
                        aria-label={`Mais opções para ${conversation.title}`}
                    >
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M4.5 8.5C5.32843 8.5 6 9.17157 6 10C6 10.8284 5.32843 11.5 4.5 11.5C3.67157 11.5 3 10.8284 3 10C3 9.17157 3.67157 8.5 4.5 8.5ZM10 8.5C10.8284 8.5 11.5 9.17157 11.5 10C11.5 10.8284 10.8284 11.5 10 11.5C9.17157 11.5 8.5 10.8284 8.5 10C8.5 9.17157 9.17157 8.5 10 8.5ZM15.5 8.5C16.3284 8.5 17 9.17157 17 10C17 10.8284 16.3284 11.5 15.5 11.5C14.6716 11.5 14 10.8284 14 10C14 9.17157 14.6716 8.5 15.5 8.5Z" />
                        </svg>
                    </button>
                </div>
            </div>
        </li>
    );
}