import { useRef, useState } from "react";
import { authErrorMessage } from "@/lib/auth";

/** Runs a user-initiated auth operation once at a time without logging credentials or server errors. */
export function useAuthAction() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ error?: { code?: string } | null }>) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) {
        setError(authErrorMessage(result.error.code));
        return false;
      }
      return true;
    } catch {
      setError("Unable to connect. Check your connection and try again.");
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return { run, pending, error, setError };
}
