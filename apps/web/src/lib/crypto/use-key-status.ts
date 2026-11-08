import { useSyncExternalStore } from "react";

import { keyManager, type KeyStatus } from "./key-manager";

const SIGNED_OUT: KeyStatus = { state: "signed-out" };

/**
 * This tab's key status from {@link keyManager}. Carries no key material, so it is safe in React
 * state and props. Server rendering always sees `signed-out`.
 */
export function useKeyStatus(): KeyStatus {
  return useSyncExternalStore(keyManager.subscribe, keyManager.getSnapshot, () => SIGNED_OUT);
}
