"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  CheckIcon,
  DownloadIcon,
  HelpIcon,
  InfoIcon,
  LanguageIcon,
  LogoutIcon,
  SettingsIcon,
  UpgradeIcon,
} from "@/components/ui/MenuIcons";
import { User } from "@/types/chatroom";
import { useState } from "react";
import { UserInfoType } from "../../../../convex/auth";

const languages = [
  { code: "en", name: "English" },
  /* { code: "pt-BR", name: "Português (Brasil)" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh", name: "中文" }, */
];

const learnMoreLinks = [
  { name: "Central de Ajuda", href: "https://support.anthropic.com" },
  { name: "Blog", href: "https://www.anthropic.com/blog" },
  { name: "Documentação da API", href: "https://docs.anthropic.com" },
  { name: "Status do sistema", href: "https://status.anthropic.com" },
];

export function UserMenu({ user }: { user: UserInfoType }) {
  const [selectedLanguage, setSelectedLanguage] = useState("en");
  const [open, setOpen] = useState(false);

  const handleSettingsClick = () => {
    console.log("Abrir configurações");
    // TODO: Implementar modal/página de configurações
  };

  const handleHelpClick = () => {
    console.log("Abrir ajuda");
    // TODO: Implementar sistema de ajuda
  };

  const handleUpgradeClick = () => {
    console.log("Upgrade do plano");
    // TODO: Redirecionar para página de upgrade
  };

  const handleDownloadClick = () => {
    console.log("Download do app");
    // TODO: Iniciar download do app
  };

  const handleLogout = () => {
    console.log("Logout");
    // TODO: Implementar logout
  };

  return (
    <div className="px-2 pb-1 transition">
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            className="inline-flex items-center justify-center h-9 px-4 py-2 rounded-lg min-w-20 active:scale-[0.985] whitespace-nowrap !scale-100 flex flex-row flex-grow items-center pointer-cursor !min-w-0 w-full hover:!bg-bg-400 !transition-all !px-1.5 py-6 gap-3 text-text-300 hover:bg-bg-300 hover:text-text-100"
            type="button"
            data-testid="user-menu-button"
          >
            {user?.profilePicture ? (
              <div className="flex-shrink-0 flex size-8 items-center justify-center rounded-full text-text-200">
                <img
                  src={user.profilePicture}
                  alt={user.name}
                  className="h-7 w-7 rounded-full object-cover"
                />
              </div>
            ) : (
              <div className="flex-shrink-0 flex size-8 items-center justify-center rounded-full text-text-200">
                <div className="flex shrink-0 items-center justify-center rounded-full font-bold select-none h-7 w-7 text-xs bg-text-200 text-bg-100">
                  {user?.name.charAt(0).toUpperCase()}
                </div>
              </div>
            )}

            <div className="transition-all duration-200 flex w-full text-sm justify-between items-center font-medium min-w-0">
              <div className="flex flex-col items-start w-full max-w-full overflow-hidden pr-4">
                <span className="w-full max-w-full overflow-hidden text-start block truncate">
                  {user?.name}
                </span>
              </div>

              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                fill="currentColor"
                viewBox="0 0 256 256"
                className={`flex-shrink-0 mr-2 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              >
                <path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z" />
              </svg>
            </div>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="end"
          className="!max-h-none !overflow-visible"
        >
          {/* Email header */}
          <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>

          {/* Configurações */}
          <DropdownMenuItem onClick={handleSettingsClick}>
            <div className="flex items-center gap-2">
              <SettingsIcon />
              <span>Configurações</span>
            </div>
            <DropdownMenuShortcut>⇧+Ctrl+,</DropdownMenuShortcut>
          </DropdownMenuItem>

          {/* Idioma - Submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <div className="flex items-center gap-2">
                <LanguageIcon />
                <span>Idioma</span>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {languages.map((lang) => (
                <DropdownMenuItem
                  key={lang.code}
                  onClick={() => setSelectedLanguage(lang.code)}
                >
                  <span>{lang.name}</span>
                  {selectedLanguage === lang.code && <CheckIcon />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Receber ajuda */}
          <DropdownMenuItem onClick={handleHelpClick}>
            <div className="flex items-center gap-2">
              <HelpIcon />
              <span>Receber ajuda</span>
            </div>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Fazer upgrade do plano */}
          <DropdownMenuItem onClick={handleUpgradeClick}>
            <div className="flex items-center gap-2">
              <UpgradeIcon />
              <span>Fazer upgrade do plano</span>
            </div>
          </DropdownMenuItem>

          {/* Baixar Claude para Windows */}
          <DropdownMenuItem onClick={handleDownloadClick}>
            <div className="flex items-center gap-2">
              <DownloadIcon />
              <span>Baixar Claude para Windows</span>
            </div>
          </DropdownMenuItem>

          {/* Saiba mais - Submenu */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <div className="flex items-center gap-2">
                <InfoIcon />
                <span>Saiba mais</span>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {learnMoreLinks.map((link) => (
                <DropdownMenuItem
                  key={link.name}
                  onClick={() => window.open(link.href, "_blank")}
                >
                  <span>{link.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {/* Sair */}
          <DropdownMenuItem onClick={handleLogout}>
            <div className="flex items-center gap-2">
              <LogoutIcon />
              <span>Sair</span>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
