import { Conversation } from '@/types';
import { ConversationItem } from './ConversationItem';

interface ConversationListProps {
    conversations: Conversation[];
}

export function ConversationList({ conversations }: ConversationListProps) {
    return (
        <div className="transition-all duration-200" aria-hidden="false">
            <div className="flex flex-col">
                <h3 className="font-ui text-text-300 pb-2 mt-1 text-xs select-none pl-2 sticky top-0 z-10 bg-gradient-to-b from-bg-200 from-50% to-bg-200/40">
                    Recentes
                </h3>
                <ul className="flex flex-col gap-px">
                    {conversations.map((conversation) => (
                        <ConversationItem key={conversation.id} conversation={conversation} />
                    ))}
                </ul>
            </div>
        </div>
    );
}