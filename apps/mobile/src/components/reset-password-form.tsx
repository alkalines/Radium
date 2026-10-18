import { useState } from "react";
import { Link } from "expo-router";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { useAuthAction } from "@/hooks/use-auth-action";
import { authClient } from "@/lib/auth-client";
import { authOptions } from "@/lib/auth";

/** Consumes a Better Auth reset-link token, not an OTP; never stores or logs the token. */
export function ResetPasswordForm({
  token,
  invalidLink = false,
}: {
  token?: string;
  invalidLink?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [complete, setComplete] = useState(false);
  const { run, pending, error, setError } = useAuthAction();
  const canReset = authOptions.passwordReset && !!token && !invalidLink;

  async function onSubmit() {
    if (!canReset || pending || complete) return;
    if (
      password.length < authOptions.minPasswordLength ||
      password.length > authOptions.maxPasswordLength
    )
      return setError(
        `Use ${authOptions.minPasswordLength}–${authOptions.maxPasswordLength} characters.`,
      );
    if (password !== confirmation) return setError("Your passwords don't match.");
    if (await run(() => authClient.resetPassword({ token, newPassword: password }))) {
      setPassword("");
      setConfirmation("");
      setComplete(true);
    }
  }

  let description = "Choose a new password for your account.";
  if (!canReset) description = "This reset link is unavailable or expired. Request a new link.";
  if (complete) description = "Your password has been updated. You can sign in now.";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset password</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        {canReset && !complete && (
          <>
            <View className="gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                accessibilityLabel="New password"
                value={password}
                onChangeText={setPassword}
                editable={!pending}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View className="gap-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                accessibilityLabel="Confirm password"
                value={confirmation}
                onChangeText={setConfirmation}
                editable={!pending}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="send"
                onSubmitEditing={() => void onSubmit()}
              />
            </View>
            {error && (
              <Text accessibilityRole="alert" className="text-sm text-destructive">
                {error}
              </Text>
            )}
            <Button disabled={pending} onPress={() => void onSubmit()}>
              <Text>{pending ? "Updating…" : "Reset password"}</Text>
            </Button>
          </>
        )}
        {!canReset && authOptions.passwordReset && (
          <Link href="/auth/forgot-password" replace asChild>
            <Button variant="outline">
              <Text>Request a new link</Text>
            </Button>
          </Link>
        )}
        <Link href="/auth/sign-in" replace asChild>
          <Button variant="link" disabled={pending}>
            <Text>Back to sign in</Text>
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
