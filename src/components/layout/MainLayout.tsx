import { Sidebar } from '../sidebar/Sidebar';

interface MainLayoutProps {
    children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
    return (
        <div className="flex min-h-screen w-full overflow-x-clip">
            <Sidebar />

            <div className="h-screen w-full relative min-w-0" style={{ padding: 0 }}>
                {children}
            </div>
        </div>
    );
}