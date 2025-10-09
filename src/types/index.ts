export interface Conversation {
    id: string;
    title: string;
    href: string;
}

export interface SidebarNavItem {
    label: string;
    href: string;
    icon: React.ReactNode;
}

export interface PromptCategory {
    id: string;
    label: string;
    icon: React.ReactNode;
}