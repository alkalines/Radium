'use client';

import { Logo } from '@/components/ui/Logo';
import { SidebarNav } from './SidebarNav';
import { ConversationList } from './ConversationList';
import { UserMenu } from './UserMenu';
import { Conversation } from '@/types';

const recentConversations: Conversation[] = [
    {
        id: '1',
        title: 'Sem título',
        href: '/chat/e2d4da28-b22c-4101-b524-fd56a3ab91aa',
    },
    {
        id: '2',
        title: 'Discord: Risks for Teenagers',
        href: '/chat/150e0208-2b37-4e94-84cd-6113af4a5b7e',
    },
    {
        id: '3',
        title: "The Impact of Mental Deterioration on Colombia's International Drug Trade",
        href: '/chat/fcbde3de-79bd-4855-978a-549ca2b4eefb',
    },
    {
        id: '4',
        title: 'CRM Strategy for a Pet Shop',
        href: '/chat/041ee6b7-e40c-4563-a8cf-d24cb993260e',
    },
    {
        id: '5',
        title: 'Greeting and Assistance',
        href: '/chat/81ed72a1-94db-47f9-bdbe-5b67b153321f',
    },
];

export function Sidebar() {
    return (
        <div className="shrink-0" style={{ overflow: 'hidden', width: 'auto', opacity: 1 }}>
            <div className="fixed z-sidebar lg:sticky" style={{ width: '18rem' }}>
                <nav
                    className="h-screen flex flex-col gap-3 pb-2 px-0 fixed top-0 left-0 transition duration-100 border-border-300 border-r-0.5 shadow-lg lg:shadow-none !bg-bg-200"
                    aria-label="Barra lateral"
                    style={{ width: '18rem' }}
                >
                    {/* Header */}
                    <div className="flex w-full items-center gap-px p-2 transition-all duration-75 ease-out">
                        <button
                            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-text-300 hover:bg-bg-300 hover:text-text-100 active:scale-95 group"
                            type="button"
                            data-testid="pin-sidebar-toggle"
                            aria-label="Barra lateral"
                        >
                            <div className="relative">
                                <div className="flex items-center justify-center group-hover:scale-80 transition scale-100 group-hover:opacity-0 text-text-300">
                                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                                        <path d="M16.5 4C17.3284 4 18 4.67157 18 5.5V14.5C18 15.3284 17.3284 16 16.5 16H3.5C2.67157 16 2 15.3284 2 14.5V5.5C2 4.67157 2.67157 4 3.5 4H16.5ZM7 15H16.5C16.7761 15 17 14.7761 17 14.5V5.5C17 5.22386 16.7761 5 16.5 5H7V15ZM3.5 5C3.22386 5 3 5.22386 3 5.5V14.5C3 14.7761 3.22386 15 3.5 15H6V5H3.5Z" />
                                    </svg>
                                </div>
                            </div>
                        </button>

                        <a className="flex flex-col justify-start items-top" aria-label="Início" href="/new">
                            <Logo />
                        </a>
                    </div>

                    {/* Content */}
                    <div className="flex flex-col align-center h-full overflow-hidden" aria-hidden="false">
                        <SidebarNav />

                        <div className="flex flex-grow flex-col overflow-y-auto overflow-x-hidden relative px-2 mb-2" tabIndex={-1}>
                            <ConversationList conversations={recentConversations} />
                        </div>

                        <UserMenu />
                    </div>
                </nav>
            </div>
        </div>
    );
}