'use client';

import { useState } from 'react';
import { CategoryButton } from './CategoryButton';

const categories = [
    {
        id: 'write',
        label: 'Escrever',
        icon: (
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                <path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z" />
            </svg>
        ),
    },
    {
        id: 'learn',
        label: 'Aprender',
        icon: (
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                <path d="M251.76,88.94l-120-64a8,8,0,0,0-7.52,0l-120,64a8,8,0,0,0,0,14.12L32,117.87v48.42a15.91,15.91,0,0,0,4.06,10.65C49.16,191.53,78.51,216,128,216a130,130,0,0,0,48-8.76V240a8,8,0,0,0,16,0V199.51a115.63,115.63,0,0,0,27.94-22.57A15.91,15.91,0,0,0,224,166.29V117.87l27.76-14.81a8,8,0,0,0,0-14.12Z" />
            </svg>
        ),
    },
    {
        id: 'code',
        label: 'Código',
        icon: (
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                <path d="M69.12,94.15,28.5,128l40.62,33.85a8,8,0,1,1-10.24,12.29l-48-40a8,8,0,0,1,0-12.29l48-40a8,8,0,0,1,10.24,12.3Zm176,27.7-48-40a8,8,0,1,0-10.24,12.3L227.5,128l-40.62,33.85a8,8,0,1,0,10.24,12.29l48-40a8,8,0,0,0,0-12.29Z" />
            </svg>
        ),
    },
    {
        id: 'personal',
        label: 'Assuntos pessoais',
        icon: (
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                <path d="M80,56V24a8,8,0,0,1,16,0V56a8,8,0,0,1-16,0Zm40,8a8,8,0,0,0,8-8V24a8,8,0,0,0-16,0V56A8,8,0,0,0,120,64Zm32,0a8,8,0,0,0,8-8V24a8,8,0,0,0-16,0V56A8,8,0,0,0,152,64Z" />
            </svg>
        ),
    },
    {
        id: 'claude-choice',
        label: 'Escolha do Claude',
        icon: (
            <svg width="20" height="20" fill="currentColor" viewBox="0 0 256 256">
                <path d="M176,232a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h80A8,8,0,0,1,176,232Zm40-128a87.55,87.55,0,0,1-33.64,69.21A16.24,16.24,0,0,0,176,186v6a16,16,0,0,1-16,16H96a16,16,0,0,1-16-16v-6a16,16,0,0,0-6.23-12.66A87.59,87.59,0,0,1,40,104.49C39.74,56.83,78.26,17.14,125.88,16A88,88,0,0,1,216,104Z" />
            </svg>
        ),
    },
];

export function PromptCategories() {
    const [activeCategory, setActiveCategory] = useState<string | null>(null);

    return (
        <div className="mx-auto w-full relative" style={{ height: 'auto', opacity: 1 }}>
            <div>
                <ul
                    className="flex flex-wrap justify-center w-full gap-2 pt-4"
                    role="tablist"
                    aria-label="Categorias de prompt"
                    style={{ opacity: 1 }}
                >
                    {categories.map((category, index) => (
                        <CategoryButton
                            key={category.id}
                            label={category.label}
                            icon={category.icon}
                            isActive={activeCategory === category.id}
                            onClick={() => setActiveCategory(category.id)}
                        />
                    ))}
                </ul>
            </div>
        </div>
    );
}