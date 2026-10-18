import "@/global.css";

import { PortalHost } from "@rn-primitives/portal";
import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import { authClient } from "@/lib/auth-client";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useTheme } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { ActivityIndicator, useColorScheme, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

import { AnimatedSplashOverlay } from "@/components/animated-icon";

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL as string, {
  unsavedChangesWarning: false,
});

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <AuthNavigator />
        <PortalHost />
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  );
}

function AuthNavigator() {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const { colors } = useTheme();

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        {/* Web SSR has no DOM from which Uniwind can resolve accent colors. */}
        <ActivityIndicator accessibilityLabel="Loading session" color={colors.text} />
      </View>
    );
  }

  // A failed lookup is not proof of logout. Keep protected content unmounted and allow retry.
  if (error) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-background px-6">
        <Text accessibilityRole="alert">Unable to check your session.</Text>
        <Button onPress={() => void refetch()}>
          <Text>Try again</Text>
        </Button>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="auth/sign-in" />
        <Stack.Screen name="auth/sign-up" />
      </Stack.Protected>
      <Stack.Screen name="auth/forgot-password" />
      <Stack.Screen name="auth/reset-password" />
    </Stack>
  );
}
