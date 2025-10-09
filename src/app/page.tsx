import { MainLayout } from '@/components/layout/MainLayout';
import { Header } from '@/components/layout/Header';
import { ChatInput } from '@/components/chat/ChatInput';
import { PromptCategories } from '@/components/chat/PromptCategories';
import { CookieBanner } from '@/components/CookieBanner';

export default function HomePage() {
    return (
        <MainLayout>
            <main className="mx-auto mt-4 w-full flex-1 px-4 md:px-8 lg:mt-6 max-w-7xl !mt-0 flex flex-col items-center gap-8 md:px-14 3xl:px-20 pt-[10vh] md:pt-[20vh] max-sm:!px-1">
                {/* Welcome Section */}
                <div className="mx-auto flex w-full flex-col items-center gap-7 max-md:pt-4 max-w-2xl">
                    <div className="ml-0.5 inline-flex items-center gap-1.5 rounded-lg h-8 px-2.5 text-center font-small sm:font-base bg-bg-300 text-text-500 select-none sm:static absolute right-2 top-3.5">
                        plano Gratuito
                        <div className="size-[3px] bg-text-500/30 rounded-full mt-0.5" />
                        <a className="inline underline hover:no-underline cursor-pointer" href="/upgrade">
                            Fazer Upgrade
                        </a>
                    </div>

                    <div
                        className="font-display text-text-200 w-full flex-col items-center text-center max-md:flex sm:-ml-0.5 sm:block transition-opacity duration-300 ease-in"
                        style={{ fontSize: 'clamp(1.875rem, 1.2rem + 2vw, 2.5rem)', lineHeight: 1.5 }}
                    >
                        <div className="inline-block max-w-full align-middle max-md:line-clamp-2 max-md:break-words md:overflow-hidden md:overflow-ellipsis select-none">
                            Feliz quinta-feira, Gabriel
                        </div>
                    </div>
                </div>

                {/* Chat Input */}
                <ChatInput />

                {/* Prompt Categories */}
                <PromptCategories />
            </main>

            <Header />
            <CookieBanner />
        </MainLayout>
    );
}