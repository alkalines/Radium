'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

export interface Model {
    id: string;
    name: string;
    description: string;
    badge?: string;
    usageInfo?: string;
    overflow?: boolean;
}

export const MODELS: Model[] = [
    {
        id: 'claude-opus-4.1',
        name: 'Opus 4.1',
        description: 'Modelo legado de brainstorming. Consome uso mais rapidamente.',
        usageInfo: '3 restantes até 19 de out.'
    },
    {
        id: 'claude-sonnet-4.5',
        name: 'Sonnet 4.5',
        description: 'Mais inteligente para tarefas do dia a dia'
    }
];

export const OVERFLOW_MODELS: Model[] = [
    {
        id: 'claude-opus-4',
        name: 'Opus 4',
        description: '',
        usageInfo: '3 restantes até 19 de out.',
        overflow: true
    },
    {
        id: 'claude-sonnet-4',
        name: 'Sonnet 4',
        description: '',
        badge: 'PRO',
        overflow: true
    },
    {
        id: 'claude-sonnet-3.7',
        name: 'Sonnet 3.7',
        description: '',
        badge: 'PRO',
        overflow: true
    },
    {
        id: 'claude-opus-3',
        name: 'Opus 3',
        description: '',
        badge: 'PRO',
        overflow: true
    },
    {
        id: 'claude-haiku-3.5',
        name: 'Haiku 3.5',
        description: 'Mais rápido para respostas rápidas',
        badge: 'PRO',
        overflow: true
    }
];

interface ModelContextType {
    selectedModel: Model;
    setSelectedModel: (model: Model) => void;
}

const ModelContext = createContext<ModelContextType | undefined>(undefined);

export const EMPTY_MODEL: Model = {
    id: '',
    name: '',
    description: ''
};

export function ModelProvider({ children }: { children: ReactNode }) {
    const [selectedModel, setSelectedModel] = useState<Model>(EMPTY_MODEL);

    return (
        <ModelContext.Provider value={{ selectedModel, setSelectedModel }}>
            {children}
        </ModelContext.Provider>
    );
}

export function useModel() {
    const context = useContext(ModelContext);
    if (context === undefined) {
        throw new Error('useModel must be used within a ModelProvider');
    }
    return context;
}