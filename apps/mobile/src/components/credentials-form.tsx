import * as React from "react";
import { Link } from "expo-router";
import { ActivityIndicator, TextInput, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { useAuthAction } from "@/hooks/use-auth-action";
import { authClient } from "@/lib/auth-client";
import { authOptions, validateCredentials } from "@/lib/auth";

/** Shared credential policy and feedback; the session guard owns successful navigation. */
export function CredentialsForm({ signUp = false }: { signUp?: boolean }) {
  const emailRef = React.useRef<React.ComponentRef<typeof TextInput>>(null);
  const passwordRef = React.useRef<React.ComponentRef<typeof TextInput>>(null);
  const confirmRef = React.useRef<React.ComponentRef<typeof TextInput>>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const { run, pending, error, setError } = useAuthAction();
  const submitLabel = signUp ? "Create account" : "Sign in";

  async function onSubmit() {
    if (pending) return;
    const validationError = validateCredentials(email, password, signUp ? name : undefined);
    if (validationError) return setError(validationError);
    if (signUp && password !== confirmPassword) return setError("Your passwords don't match.");

    await run(() => {
      if (signUp) {
        return authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
      }
      return authClient.signIn.email({ email: email.trim(), password });
    });
  }

  return (
    <Card className="border-0 shadow-none sm:border sm:border-border">
      <CardHeader>
        <CardTitle className="text-2xl">
          {signUp ? "Create your account" : "Welcome back"}
        </CardTitle>
        <CardDescription>
          {signUp
            ? "Enter your details to get started with Radium."
            : "Sign in to your Radium account to continue."}
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        {signUp && (
          <View className="gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              accessibilityLabel="Name"
              placeholder="Your name"
              value={name}
              onChangeText={setName}
              editable={!pending}
              autoComplete="name"
              textContentType="name"
              returnKeyType="next"
              onSubmitEditing={() => emailRef.current?.focus()}
              submitBehavior="submit"
            />
          </View>
        )}
        <View className="gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            ref={emailRef}
            id="email"
            accessibilityLabel="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
            editable={!pending}
            keyboardType="email-address"
            autoComplete="email"
            textContentType="emailAddress"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
        </View>
        <View className="gap-2">
          <Label htmlFor="password">Password</Label>
          <Input
            ref={passwordRef}
            id="password"
            accessibilityLabel="Password"
            value={password}
            onChangeText={setPassword}
            editable={!pending}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete={signUp ? "new-password" : "current-password"}
            textContentType={signUp ? "newPassword" : "password"}
            returnKeyType={signUp ? "next" : "go"}
            submitBehavior="submit"
            onSubmitEditing={() => (signUp ? confirmRef.current?.focus() : void onSubmit())}
          />
          {signUp && (
            <Text className="text-xs text-muted-foreground">
              Use {authOptions.minPasswordLength}–{authOptions.maxPasswordLength} characters.
            </Text>
          )}
        </View>
        {signUp && (
          <View className="gap-2">
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input
              ref={confirmRef}
              id="confirm-password"
              accessibilityLabel="Confirm password"
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              editable={!pending}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              returnKeyType="go"
              onSubmitEditing={() => void onSubmit()}
            />
          </View>
        )}
        <View className="flex-row items-center justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onPress={() => setShowPassword(!showPassword)}
            accessibilityLabel={showPassword ? "Hide password" : "Show password"}
          >
            <Text>{showPassword ? "Hide password" : "Show password"}</Text>
          </Button>
          {!signUp && authOptions.passwordReset && (
            <Link href="/auth/forgot-password" asChild>
              <Button variant="link" size="sm" disabled={pending}>
                <Text>Forgot password?</Text>
              </Button>
            </Link>
          )}
        </View>
        {error && (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="text-sm text-destructive"
          >
            {error}
          </Text>
        )}
        <Button
          disabled={pending}
          accessibilityState={{ busy: pending }}
          onPress={() => void onSubmit()}
        >
          {pending && <ActivityIndicator colorClassName="accent-primary-foreground" />}
          <Text>{pending ? "Please wait…" : submitLabel}</Text>
        </Button>
        <View className="items-center gap-1">
          <Text className="text-sm text-muted-foreground">
            {signUp ? "Already have an account?" : "Don't have an account?"}
          </Text>
          <Link href={signUp ? "/auth/sign-in" : "/auth/sign-up"} replace asChild>
            <Button variant="link" disabled={pending}>
              <Text>{signUp ? "Sign in" : "Sign up"}</Text>
            </Button>
          </Link>
        </View>
      </CardContent>
    </Card>
  );
}
