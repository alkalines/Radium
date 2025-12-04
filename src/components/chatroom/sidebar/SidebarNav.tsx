import Link from 'next/link';
import { cn } from '@/lib/utils';

interface SidebarItemProps {
    href: string;
    icon: React.ReactNode;
    label: string;
    isActive?: boolean;
}

function SidebarItem({ href, icon, label, isActive = false }: SidebarItemProps) {
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
                    isActive && 'bg-bg-400 text-text-100 '
                )}
                aria-label={label}
            >
                <div className="-translate-x-2 w-full flex flex-row items-center justify-start gap-3">
                    <div className="size-4 flex items-center justify-center">{icon}</div>
                    <span className="truncate text-sm whitespace-nowrap w-full">
            <div className="font-ui transition-all duration-200">{label}</div>
          </span>
                </div>
            </Link>
        </div>
    );
}

export function SidebarNav() {
    return (
        <div className="flex flex-col px-2 pt-1 gap-px mb-6">
            <div className="mb-1">
                <div data-state="closed">
                    <a
                        href="/new"
                        className="font-ui items-center h-9 px-4 py-2 rounded-lg active:scale-[0.985] whitespace-nowrap group transition ease-in-out active:!scale-100 hover:bg-transparent flex !justify-start !min-w-0 w-full active:!bg-accent-brand/15"
                        aria-label="Novo bate-papo"
                    >
                        <div className="-mx-3 flex flex-row items-center gap-2">
                            <div className="w-6 h-6 flex items-center justify-center group-active:!scale-[0.98] group-hover:-rotate-3 group-hover:scale-110 group-active:rotate-6 rounded-full transition-all ease-in-out bg-accent-main-100 group-hover:shadow-md">
                                <div
                                    className="flex items-center justify-center group-hover:scale-105 transition text-white">
                                    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"
                                         xmlns="http://www.w3.org/2000/svg"
                                         className="shrink-0 group-hover:scale-105 transition text-always-white"
                                         aria-hidden="true">
                                        <path
                                            d="M10 3C10.4142 3 10.75 3.33579 10.75 3.75V9.25H16.25C16.6642 9.25 17 9.58579 17 10C17 10.3882 16.7051 10.7075 16.3271 10.7461L16.25 10.75H10.75V16.25C10.75 16.6642 10.4142 17 10 17C9.58579 17 9.25 16.6642 9.25 16.25V10.75H3.75C3.33579 10.75 3 10.4142 3 10C3 9.58579 3.33579 9.25 3.75 9.25H9.25V3.75C9.25 3.33579 9.58579 3 10 3Z"/>
                                    </svg>
                                </div>
                            </div>
                            <div className="transition-all duration-200 text-text-300  font-medium text-sm">
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
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"
                         xmlns="http://www.w3.org/2000/svg" className="shrink-0 group" aria-hidden="true">
                        <path className="group-hover:-translate-x-[0.5px] transition group-active:translate-x-0"
                              d="M8.99962 2C12.3133 2 14.9996 4.68629 14.9996 8C14.9996 11.3137 12.3133 14 8.99962 14H2.49962C2.30105 13.9998 2.12113 13.8821 2.04161 13.7002C1.96224 13.5181 1.99835 13.3058 2.1334 13.1602L3.93516 11.2178C3.34317 10.2878 2.99962 9.18343 2.99962 8C2.99962 4.68643 5.68609 2.00022 8.99962 2ZM8.99962 3C6.23838 3.00022 3.99961 5.23871 3.99961 8C3.99961 9.11212 4.36265 10.1386 4.97618 10.9688C5.11884 11.1621 5.1035 11.4293 4.94004 11.6055L3.64512 13H8.99962C11.761 13 13.9996 10.7614 13.9996 8C13.9996 5.23858 11.761 3 8.99962 3Z"/>
                        <path className="group-hover:translate-x-[0.5px] transition group-active:translate-x-0"
                              d="M16.5445 9.72754C16.4182 9.53266 16.1678 9.44648 15.943 9.53418C15.7183 9.62215 15.5932 9.85502 15.6324 10.084L15.7369 10.3955C15.9073 10.8986 16.0006 11.438 16.0006 12C16.0006 13.1123 15.6376 14.1386 15.024 14.9687C14.8811 15.1621 14.8956 15.4302 15.0592 15.6064L16.3531 17H11.0006C9.54519 17 8.23527 16.3782 7.32091 15.3848L7.07091 15.1103C6.88996 14.9645 6.62535 14.9606 6.43907 15.1143C6.25267 15.2682 6.20668 15.529 6.31603 15.7344L6.58458 16.0625C7.68048 17.253 9.25377 18 11.0006 18H17.5006C17.6991 17.9998 17.8791 17.8822 17.9586 17.7002C18.038 17.5181 18.0018 17.3058 17.8668 17.1602L16.0631 15.2178C16.6554 14.2876 17.0006 13.1837 17.0006 12C17.0006 11.3271 16.8891 10.6792 16.6842 10.0742L16.5445 9.72754Z"/>
                    </svg>
                }
            />

            <SidebarItem
                href="/projects"
                label="Projetos"
                icon={
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"
                         xmlns="http://www.w3.org/2000/svg" className="shrink-0 group" aria-hidden="true">
                        <path className="group-hover:scale-95 origin-center"
                              d="M15.8198 7C16.6885 7.00025 17.3624 7.73158 17.3178 8.57617L17.2993 8.74707L16.1332 15.7471C16.0126 16.4699 15.3865 16.9996 14.6538 17H5.34711C4.6142 16.9998 3.98833 16.47 3.86762 15.7471L2.7016 8.74707C2.54922 7.83277 3.25418 7 4.18109 7H15.8198ZM4.18109 8C3.87216 8 3.63722 8.27731 3.68793 8.58203L4.85394 15.582C4.89413 15.8229 5.10291 15.9998 5.34711 16H14.6538C14.8978 15.9996 15.1068 15.8228 15.1469 15.582L16.3129 8.58203L16.3188 8.46973C16.3036 8.21259 16.0899 8.00023 15.8198 8H4.18109Z"/>
                        <path
                            className="group-hover:-translate-y-[1.4px] group-hover:translate-x-[0.5px] group-hover:rotate-3 transition group-active:translate-y-0"
                            d="M16.0004 5.5C16.0004 5.224 15.7764 5.00024 15.5004 5H4.50043C4.22428 5 4.00043 5.22386 4.00043 5.5C4.00043 5.77614 4.22428 6 4.50043 6H15.5004C15.7764 5.99976 16.0004 5.776 16.0004 5.5Z"/>
                        <path
                            className="group-hover:-translate-y-[2.8px] group-hover:translate-x-px group-hover:rotate-6 transition group-active:translate-y-0"
                            d="M14.5004 3.5C14.5004 3.224 14.2764 3.00024 14.0004 3H6.00043C5.72428 3 5.50043 3.22386 5.50043 3.5C5.50043 3.77614 5.72428 4 6.00043 4H14.0004C14.2764 3.99976 14.5004 3.776 14.5004 3.5Z"/>
                    </svg>
                }
            />

            <SidebarItem
                href="/artifacts"
                label="Artefatos"
                icon={
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"
                         xmlns="http://www.w3.org/2000/svg" className="shrink-0 group backface-hidden"
                         aria-hidden="true">
                        <path fillRule="evenodd" clipRule="evenodd"
                              d="M6.35352 3.1464L9.35352 6.14642C9.43935 6.25103 9.5 6.36003 9.5 6.50091C9.4998 6.6332 9.44704 6.75988 9.35352 6.85346L6.35352 9.85347C6.14584 10.0609 5.85611 10.0243 5.64648 9.85347L2.64648 6.85346C2.55296 6.75988 2.5002 6.6332 2.5 6.50091C2.5 6.36841 2.55285 6.24017 2.64648 6.14642L5.64648 3.1464C5.8552 2.97421 6.14635 2.93936 6.35352 3.1464ZM6 8.79194L3.70703 6.49994L6 4.20696L8.29297 6.49994L6 8.79194Z"/>
                        <path className="group-hover:-rotate-90 transition-transform duration-200 ease-snappy-out"
                              d="M16.8984 3.7509C16.9875 3.90632 16.986 4.09826 16.8955 4.25286L15.5791 6.49994L16.8955 8.74702C16.986 8.90159 16.9874 9.09354 16.8984 9.24898C16.8093 9.40436 16.643 9.49996 16.4638 9.49996H11.5C11.3198 9.49996 11.1532 9.4028 11.0644 9.24605C10.976 9.08949 10.9789 8.89736 11.0713 8.74312L12.417 6.49994L11.0713 4.25676C10.9789 4.1025 10.976 3.91037 11.0644 3.75383C11.1532 3.59717 11.3199 3.49992 11.5 3.49992H16.4638C16.6429 3.51309 16.8055 3.58909 16.8984 3.7509ZM13.4287 6.2431C13.5152 6.4107 13.5166 6.58638 13.4287 6.75678L12.3828 8.49995H15.5918L14.5683 6.75287C14.477 6.59683 14.477 6.40303 14.5683 6.24701L15.5918 4.49993H12.3828L13.4287 6.2431Z"
                              style={{ transformOrigin: '14px 6.5px' }}/>
                        <path className="group-hover:rotate-[120deg] transition-transform duration-200 ease-snappy-out"
                              fillRule="evenodd" clipRule="evenodd"
                              d="M7.25293 10.9668C7.40708 10.8793 7.59647 10.8801 7.75 10.9687C7.90356 11.0574 7.99869 11.2211 8 11.3984L8.01074 12.8388L9.30762 13.6054C9.42811 13.6994 9.49994 13.8448 9.5 14C9.5 14.1773 9.40587 14.3418 9.25293 14.4316L8.01074 15.1601L7.99512 16.667C7.97406 16.8184 7.88446 16.9536 7.75 17.0312C7.59642 17.1199 7.40713 17.1207 7.25293 17.0332L6 16.3203L4.74707 17.0332C4.59287 17.1207 4.40358 17.1199 4.25 17.0312C4.09643 16.9425 4.00124 16.7789 4 16.6015L3.99023 15.1601L2.74707 14.4316C2.59413 14.3418 2.5 14.1773 2.5 14C2.50006 13.8448 2.57188 13.6994 2.69238 13.6054L3.99023 12.8388L4 11.3984C4.00131 11.2211 4.09644 11.0574 4.25 10.9687C4.40353 10.8801 4.59292 10.8793 4.74707 10.9668L6 11.6787L7.25293 10.9668ZM4.99512 12.2568L5.75293 12.6884C5.90608 12.7754 6.09392 12.7754 6.24707 12.6884L7.00586 12.2568L7.01172 13.1308C7.01308 13.3068 7.10706 13.4695 7.25879 13.5586L8.01172 14L7.25879 14.4414C7.10706 14.5304 7.01315 14.6932 7.01172 14.8691L7.00586 15.7422L6.24707 15.3115C6.09397 15.2246 5.90603 15.2246 5.75293 15.3115L4.99512 15.7422L4.98828 14.8691C4.98703 14.7152 4.91459 14.5716 4.79492 14.4785L3.98926 14L4.74121 13.5586C4.87421 13.4805 4.96267 13.3457 4.9834 13.1953L4.99512 12.2568Z"
                              style={{ transformOrigin: '6px 14px' }}/>
                        <path fillRule="evenodd" clipRule="evenodd"
                              d="M14 11C15.6568 11 16.9999 12.3432 17 14C17 15.6568 15.6569 17 14 17C12.3431 17 11 15.6568 11 14C11.0001 12.3432 12.3432 11 14 11ZM12 14C12.0001 12.8955 12.8955 12 14 12C15.1045 12 15.9999 12.8955 16 14C16 15.1045 15.1046 16 14 16C12.8954 16 12 15.1045 12 14Z"/>
                    </svg>

                }
            />
        </div>
    );
}