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

export interface User {
    name: string;
    email: string;
    initials: string;
    plan: string;
}

export interface ChatConfig {
    user: User;
    conversations: Conversation[];
    welcomeMessage: string;
}