import { CryptoError } from "radium-crypto";
import { onSecretsCleared } from "./runtime";
import { trust, type PublicIdentity } from "./trust-store";
/** Public-only description of a blocked key exchange. */
export type IdentityTrustRequest = {
  identity: PublicIdentity;
  trustState: "first-contact" | "changed";
};
type PendingRequest = IdentityTrustRequest & {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};
const queue: PendingRequest[] = [];
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
onSecretsCleared(() => {
  for (const pending of queue)
    pending.reject(new CryptoError("DECRYPT_FAILED", "Key exchange cancelled by lock"));
  queue.length = 0;
  emit();
});
/** Waits for an explicit user decision before proceeding; locking cancels every pending exchange. */
export async function requestIdentityTrust(
  identity: PublicIdentity,
  trustState: "first-contact" | "changed",
): Promise<void> {
  let pending = queue.find(
    (entry) =>
      entry.identity.userId === identity.userId &&
      entry.identity.keyId === identity.keyId &&
      entry.identity.fingerprint === identity.fingerprint,
  );
  if (!pending) {
    const deferred = Promise.withResolvers<void>();
    pending = { identity, trustState, ...deferred };
    queue.push(pending);
    emit();
  }
  await pending.promise;
  const accepted = await trust.check(identity.userId, identity);
  if (accepted !== "self" && accepted !== "tofu" && accepted !== "verified") {
    throw new CryptoError("DECRYPT_FAILED", "Identity approval failed");
  }
}
/** Public queue subscription for the single Window trust surface. */
export const trustRequests = {
  getSnapshot: (): IdentityTrustRequest | null => queue[0] ?? null,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  approve(): void {
    const accepted = queue.shift();
    accepted?.resolve();
    emit();
  },
  deny(): void {
    const denied = queue.shift();
    denied?.reject(new CryptoError("DECRYPT_FAILED", "Identity denied"));
    emit();
  },
};
