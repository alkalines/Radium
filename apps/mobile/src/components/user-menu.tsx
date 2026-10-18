import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Text } from "@/components/ui/text";
import { useAuthAction } from "@/hooks/use-auth-action";
import { authClient } from "@/lib/auth-client";
import { LogOutIcon } from "lucide-react-native";
import { View } from "react-native";

/** Displays the current Better Auth user and signs out through the same persisted client. */
export function UserMenu() {
  const { data: session } = authClient.useSession();
  const { run, pending, error } = useAuthAction();
  const user = session?.user;
  if (!user) return null;
  const initials = (user.name || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="self-end" accessibilityLabel="Open account menu">
          <Avatar alt={user.name || "Your account"} className="size-8">
            {user.image && <AvatarImage source={{ uri: user.image }} />}
            <AvatarFallback>
              <Text>{initials}</Text>
            </AvatarFallback>
          </Avatar>
          <Text numberOfLines={1}>{user.name || "Your account"}</Text>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-4">
        <View className="gap-1">
          <Text className="font-semibold">{user.name}</Text>
          <Text className="text-sm text-muted-foreground" selectable>
            {user.email}
          </Text>
        </View>
        {error && (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error}
          </Text>
        )}
        <Button
          variant="outline"
          disabled={pending}
          onPress={() => void run(() => authClient.signOut())}
        >
          <Icon as={LogOutIcon} className="size-4" />
          <Text>{pending ? "Signing out…" : "Sign out"}</Text>
        </Button>
      </PopoverContent>
    </Popover>
  );
}
