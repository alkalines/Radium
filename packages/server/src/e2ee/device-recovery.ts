import {
  decodeExactBytes,
  DEVICE_RECOVERY_SLOT_BYTES,
  DEVICE_RECOVERY_TTL_MS,
} from "contracts/e2ee/contract";
import { AMK_WRAPPER_BYTES, sha256, toBase64Url, utf8 } from "radium-crypto";
import { takeToken, type RateLimit } from "../auth/ratelimit";
import type { Kv } from "../drivers/types";
import { AppError } from "../errors";
import { kvRun, kvScript, kvTake } from "../kv";

/**
 * Password reset through another device where the user is still unlocked
 * (`docs/E2EE/Authentication.md`, "Flows"). The resetting page derives `slotId` and a wrapping key
 * from a 16-byte secret shown only on its screen; the unlocked device, given the secret's words,
 * offers the AMK wrapped under that key in the slot; the resetting page takes it once. The server
 * only relays ciphertext and never learns the secret: the slot id is a 256-bit HKDF output, so it
 * is both unguessable and useless for opening `sealedAmk`.
 *
 * Offers live in Valkey only (`Runtime.md`): one key per slot holding `<userId> <sealedAmk>`,
 * expiring after {@link DEVICE_RECOVERY_TTL_MS}; taking it is `GETDEL`, so it is single use.
 */

/** A user offers once per reset; retries and typos stay well within this. */
const OFFERS: RateLimit = { name: "e2ee-recovery-offer", capacity: 10, periodMs: 15 * 60_000 };
/** The resetting page polls every few seconds while it waits. */
const TAKES: RateLimit = { name: "e2ee-recovery-take", capacity: 60, periodMs: 60_000 };

const slotKey = (slotId: string) => `e2ee:recovery:${slotId}`;

/**
 * Stores the offer unless the slot holds another user's offer. KEYS[1] slot; ARGV owner, value,
 * ttl (ms). Returns 1 when stored.
 */
const OFFER = kvScript(`
local current = redis.call('GET', KEYS[1])
if current and string.sub(current, 1, string.len(ARGV[1]) + 1) ~= ARGV[1] .. ' ' then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`);

function tooMany(): never {
  throw new AppError("FORBIDDEN", "Too many attempts. Try again shortly.");
}

/**
 * The signed-in (unlocked) device offers its wrapped AMK for one slot. Offering the same slot
 * again replaces the earlier offer and its expiry; a slot holding another user's offer is refused
 * instead of overwritten.
 */
export async function offerDeviceRecovery(
  kv: Kv,
  userId: string,
  input: { slotId: string; sealedAmk: Uint8Array },
): Promise<void> {
  if (
    decodeExactBytes(input.slotId, DEVICE_RECOVERY_SLOT_BYTES) === null ||
    input.sealedAmk.byteLength !== AMK_WRAPPER_BYTES
  ) {
    throw new AppError("BAD_REQUEST", "Invalid device recovery offer.");
  }
  if (!(await takeToken(kv, OFFERS, userId))) {
    tooMany();
  }
  const stored = await kvRun(
    kv,
    OFFER,
    [slotKey(input.slotId)],
    [userId, `${userId} ${toBase64Url(input.sealedAmk)}`, String(DEVICE_RECOVERY_TTL_MS)],
  );
  if (Number(stored) !== 1) {
    throw new AppError("CONFLICT", "Device recovery slot is taken.");
  }
}

/**
 * Takes the offer of a slot, if any. The resetting page has no session, so knowing the slot id is
 * the only authorization (see the module comment). Single use: the offer is read and deleted in
 * one `GETDEL`; an expired offer no longer exists. Rate-limited per client address, or per slot
 * when the request has none. Returns `null` while nothing (unexpired) was offered.
 */
export async function takeDeviceRecovery(
  kv: Kv,
  clientAddress: string | null,
  slotId: string,
): Promise<{ sealedAmk: string } | null> {
  if (decodeExactBytes(slotId, DEVICE_RECOVERY_SLOT_BYTES) === null) {
    throw new AppError("BAD_REQUEST", "Invalid device recovery slot.");
  }
  // Rate-limit keys are visible to anyone with Valkey access: addresses are hashed.
  const bucket = clientAddress
    ? `ip:${toBase64Url(await sha256(utf8(clientAddress)))}`
    : `slot:${slotId}`;
  if (!(await takeToken(kv, TAKES, bucket))) {
    tooMany();
  }
  const offer = await kvTake(kv, slotKey(slotId));
  return offer ? { sealedAmk: offer.slice(offer.indexOf(" ") + 1) } : null;
}
