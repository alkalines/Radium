import { useState } from "react";
import { Link } from "expo-router";
import * as Linking from "expo-linking";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { useAuthAction } from "@/hooks/use-auth-action";
import { authClient } from "@/lib/auth-client";
import { authOptions } from "@/lib/auth";

/** Link-based recovery, available only after email delivery is configured on the backend. */
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { run, pending, error, setError } = useAuthAction();

  async function onSubmit() {
    if (!authOptions.passwordReset || pending || sent) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      return setError("Enter a valid email address.");
    const success = await run(() =>
      authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: Linking.createURL("/auth/reset-password"),
      }),
    );
    if (success) setSent(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Forgot password?</CardTitle>
        <CardDescription>
          {!authOptions.passwordReset
            ? "Password recovery isn't available on this server yet."
            : sent
              ? "If an account exists for that email, you'll receive a password reset link."
              : "Enter your email and we'll send you a reset link."}
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        {authOptions.passwordReset && !sent && (
          <>
            <View className="gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                accessibilityLabel="Email"
                value={email}
                onChangeText={setEmail}
                editable={!pending}
                keyboardType="email-address"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="you@example.com"
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
              <Text>{pending ? "Sending…" : "Send reset link"}</Text>
            </Button>
          </>
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
