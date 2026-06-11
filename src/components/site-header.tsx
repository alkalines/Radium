import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useSidebar } from "@/components/ui/sidebar";
import { useRouterState } from "@tanstack/react-router";
import { PanelLeftIcon } from "lucide-react";

export function SiteHeader() {
  const { toggleSidebar } = useSidebar();
  const pageTitle = useRouterState({
    select: (state) => {
      const configuredTitle = state.matches.toReversed().find((match) => match.staticData.pageTitle)
        ?.staticData.pageTitle;

      return configuredTitle ?? titleize(state.location.pathname);
    },
  });

  return (
    <header className="sticky top-0 z-50 flex w-full items-center border-b bg-background">
      <div className="flex h-(--header-height) w-full items-center gap-2 px-4">
        <Button className="h-8 w-8" variant="ghost" size="icon" onClick={toggleSidebar}>
          <PanelLeftIcon />
        </Button>
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-auto"
        />
        <Breadcrumb className="hidden min-w-0 sm:block">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[calc(100vw-8rem)] truncate">
                {pageTitle}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </header>
  );
}

function titleize(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).at(-1) ?? "Home";

  return segment
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
