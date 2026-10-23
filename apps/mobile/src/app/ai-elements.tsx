import { Redirect, Stack } from "expo-router";
import { ScrollView } from "react-native";
import { AiElementsGallery } from "@/components/ai-elements/gallery";

/** Development-only fixture screen; its root navigator requires an authenticated session. */
export default function AiElementsScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ title: "AI Elements" }} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <AiElementsGallery />
      </ScrollView>
    </>
  );
}
