import { useLocalSearchParams } from "expo-router";
import { AuthView } from "@/components/auth-view";
import { ResetPasswordForm } from "@/components/reset-password-form";

export default function ResetPasswordScreen() {
  const { token, error } = useLocalSearchParams<{
    token?: string | string[];
    error?: string | string[];
  }>();
  return (
    <AuthView>
      <ResetPasswordForm
        token={typeof token === "string" ? token : undefined}
        invalidLink={!!error}
      />
    </AuthView>
  );
}
