/** UI capabilities must match the selected backend; these do not enable server features. */
export const authOptions = {
  passwordReset: false,
  minPasswordLength: 8,
  maxPasswordLength: 128,
};

/** Known failures are safe to display; unknown server errors stay private. */
export function authErrorMessage(code?: string) {
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
      return "The email or password is incorrect.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "An account with this email already exists. Try signing in.";
    case "EMAIL_NOT_VERIFIED":
      return "Verify your email before signing in.";
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
      return "This link is invalid or expired. Request a new one.";
    case "TOO_MANY_REQUESTS":
      return "Too many attempts. Please wait before trying again.";
    default:
      return "We couldn't complete that request. Please try again.";
  }
}

/** Validates for local feedback only; Better Auth remains the authority on credentials. */
export function validateCredentials(email: string, password: string, name?: string) {
  if (name !== undefined && !name.trim()) return "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Enter a valid email address.";
  if (!password) return "Enter your password.";
  if (
    name !== undefined &&
    (password.length < authOptions.minPasswordLength ||
      password.length > authOptions.maxPasswordLength)
  ) {
    return `Use between ${authOptions.minPasswordLength} and ${authOptions.maxPasswordLength} characters for your password.`;
  }
  return null;
}
