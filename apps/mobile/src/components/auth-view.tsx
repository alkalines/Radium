import type { PropsWithChildren } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView as NativeSafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";
import { Text } from "@/components/ui/text";

// This third-party native view needs an explicit className-to-style bridge.
const SafeAreaView = withUniwind(NativeSafeAreaView);

/** Shared auth shell with safe areas, keyboard avoidance, and a constrained, scrollable form. */
export function AuthView({ children }: PropsWithChildren) {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="grow justify-center px-6 py-10"
        >
          <View className="mx-auto w-full max-w-md gap-8">
            <View className="items-center gap-2">
              <View className="size-12 items-center justify-center rounded-2xl bg-primary">
                <Text className="text-2xl font-semibold text-primary-foreground">Ra</Text>
              </View>
              <Text className="text-lg font-semibold tracking-tight">Radium</Text>
              <Text className="text-center text-sm text-muted-foreground">
                Your agents. Your infrastructure.
              </Text>
            </View>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
