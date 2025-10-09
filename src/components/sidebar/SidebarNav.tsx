import { SidebarItem } from './SidebarItem';

export function SidebarNav() {
    return (
        <div className="flex flex-col px-2 pt-1 gap-px mb-6">
            <div className="mb-1">
                <div data-state="closed">
                    <a
                        href="/new"
                        className="inline-flex items-center justify-center h-9 px-4 py-2 rounded-lg min-w-20 active:scale-[0.985] whitespace-nowrap group transition ease-in-out active:!scale-100 hover:bg-transparent flex !justify-start !min-w-0 w-full hover:!bg-accent-main-000/[0.08] active:!bg-accent-brand/15"
                        aria-label="Novo bate-papo"
                    >
                        <div className="-mx-3 flex flex-row items-center gap-2">
                            <div className="w-6 h-6 flex items-center justify-center group-active:!scale-[0.98] group-hover:-rotate-3 group-hover:scale-110 group-active:rotate-6 rounded-full transition-all ease-in-out bg-accent-main-000 group-hover:shadow-md">
                                <div className="flex items-center justify-center group-hover:scale-105 transition text-white">
                                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                                        <path d="M10 3C10.4142 3 10.75 3.33579 10.75 3.75V9.25H16.25C16.6642 9.25 17 9.58579 17 10C17 10.3882 16.7051 10.7075 16.3271 10.7461L16.25 10.75H10.75V16.25C10.75 16.6642 10.4142 17 10 17C9.58579 17 9.25 16.6642 9.25 16.25V10.75H3.75C3.33579 10.75 3 10.4142 3 10C3 9.58579 3.33579 9.25 3.75 9.25H9.25V3.75C9.25 3.33579 9.58579 3 10 3Z" />
                                    </svg>
                                </div>
                            </div>
                            <div className="transition-all duration-200 text-accent-main-100 font-medium text-sm">
                                Novo bate-papo
                            </div>
                        </div>
                    </a>
                </div>
            </div>

            <SidebarItem
                href="/recents"
                label="Conversas"
                icon={
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M8.99962 2C12.3133 2 14.9996 4.68629 14.9996 8C14.9996 11.3137 12.3133 14 8.99962 14H2.49962C2.30105 13.9998 2.12113 13.8821 2.04161 13.7002C1.96224 13.5181 1.99835 13.3058 2.1334 13.1602L3.93516 11.2178C3.34317 10.2878 2.99962 9.18343 2.99962 8C2.99962 4.68643 5.68609 2.00022 8.99962 2Z" />
                    </svg>
                }
            />

            <SidebarItem
                href="/projects"
                label="Projetos"
                icon={
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                        <path d="M15.8198 7C16.6885 7.00025 17.3624 7.73158 17.3178 8.57617L17.2993 8.74707L16.1332 15.7471C16.0126 16.4699 15.3865 16.9996 14.6538 17H5.34711C4.6142 16.9998 3.98833 16.47 3.86762 15.7471L2.7016 8.74707C2.54922 7.83277 3.25418 7 4.18109 7H15.8198Z" />
                    </svg>
                }
            />

            <SidebarItem
                href="/artifacts"
                label="Artefatos"
                icon={
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" clipRule="evenodd" d="M6.35352 3.1464L9.35352 6.14642C9.43935 6.25103 9.5 6.36003 9.5 6.50091C9.4998 6.6332 9.44704 6.75988 9.35352 6.85346L6.35352 9.85347C6.14584 10.0609 5.85611 10.0243 5.64648 9.85347L2.64648 6.85346C2.55296 6.75988 2.5002 6.6332 2.5 6.50091C2.5 6.36841 2.55285 6.24017 2.64648 6.14642L5.64648 3.1464C5.8552 2.97421 6.14635 2.93936 6.35352 3.1464Z" />
                    </svg>
                }
            />
        </div>
    );
}