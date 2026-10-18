import { CredentialsForm } from "@/components/credentials-form";

/** Uses Better Auth's automatic sign-in; no separate token storage is introduced. */
export function SignUpForm() {
  return <CredentialsForm signUp />;
}
