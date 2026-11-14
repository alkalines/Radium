import type { ConvexClient } from "convex/browser";
import { api } from "backend/convex/_generated/api";
import {
  CryptoError,
  fingerprint,
  fromBase64Url,
  sha256,
  sign,
  toBase64Url,
  verify,
  verifyIdentitySelfSignature,
  verifyRoster,
  workerObjectStatement,
  type RosterOwner,
  type WorkspaceRoster,
} from "radium-crypto";
import type { WorkerE2eeKeys, WorkerState } from "../auth/state.js";
import { TrustMarks } from "./marks.js";

/** Signed roster and public workspace epochs, as served by `e2ee.workerTrustState`. */
export interface WorkerTrustState {
  roster: {
    version: number;
    body: ArrayBuffer;
    signature: ArrayBuffer;
    signerKeyId: string;
  } | null;
  epochs: {
    epoch: number;
    memberKeyId: string;
    memberPublicKey: ArrayBuffer;
    ownerKeyId: string;
    ownerPublicKey: ArrayBuffer;
  }[];
}

/** A public user identity, as served by `e2ee.workerIdentities` (null: unknown or not a workspace user). */
export interface WorkerTrustIdentity {
  userId: string;
  keyId: string;
  suite: number;
  encryptionPublicKey: ArrayBuffer;
  signingPublicKey: ArrayBuffer;
  selfSignature: ArrayBuffer;
  status: "active" | "retired";
}

/** Backend reads `WorkerTrust` needs; a seam for tests. Nothing it returns is trusted unverified. */
export interface WorkerTrustTransport {
  trustState(): Promise<WorkerTrustState>;
  identities(keyIds: string[]): Promise<(WorkerTrustIdentity | null)[]>;
  close(): void;
}

/** Why a paired Worker refuses everything until the cause is fixed. */
export type WorkerTrustFailure = "owner_changed" | "rollback" | "not_listed" | "invalid";

const FAILURE_MESSAGES: Record<WorkerTrustFailure, string> = {
  owner_changed:
    "The workspace owner's key changed. This Worker refuses all commands until it is paired again: create a pairing code on the Workers page and run `radium-worker pair`.",
  rollback:
    "The backend served an older workspace roster than this Worker has seen. This Worker refuses all commands until a newer roster is published.",
  not_listed:
    "This Worker is not certified by the workspace roster (not yet certified, re-paired elsewhere, or revoked). It refuses all commands until the owner certifies it: open the Workers page while unlocked, or pair it again.",
  invalid:
    "The workspace roster or keys served by the backend failed verification. This Worker refuses all commands until they verify.",
};

/** A paired Worker's trust anchor failed; the message is fixed and safe to log. */
export class WorkerTrustError extends Error {
  constructor(readonly reason: WorkerTrustFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "WorkerTrustError";
  }
}

/** Live `e2ee.workerTrustState` subscription plus on-demand identity reads over the control client. */
export function convexTrustTransport(client: ConvexClient): WorkerTrustTransport {
  let latest: WorkerTrustState | undefined;
  const unsubscribe = client.onUpdate(
    api.e2ee.workerTrustState,
    {},
    (state) => {
      latest = state;
    },
    () => {
      latest = undefined;
    },
  );
  return {
    async trustState() {
      return latest ?? (await client.query(api.e2ee.workerTrustState, {}));
    },
    identities: (keyIds) => client.query(api.e2ee.workerIdentities, { keyIds }),
    close: unsubscribe,
  };
}

/**
 * Trust anchor of a paired Worker (Keys.md "Workers", "Trust System"): its own E2EE keys, the owner
 * pinned from the setup or pairing code, and persisted rollback marks. Everything the backend serves
 * (roster, epochs, identities) is verified here before the Worker acts on it. Constructed in
 * `cli/start.ts` only when the Worker is paired; unpaired Workers pass `null` to consumers.
 */
export class WorkerTrust {
  readonly workerId: string;
  readonly workspaceId: string;
  /** ID of this Worker's E2EE key set (not the machine-auth key ID). */
  readonly keyId: string;

  private readonly owner: RosterOwner;
  private ownFingerprint: Promise<string>;
  private verified: { signature: string; roster: WorkspaceRoster } | undefined;
  private readonly identityCache = new Map<string, WorkerTrustIdentity>();
  private loggedFailure: WorkerTrustFailure | undefined;

  private constructor(
    private readonly keys: WorkerE2eeKeys,
    identity: { workerId: string; workspaceId: string },
    private readonly transport: WorkerTrustTransport,
    private readonly marks: TrustMarks,
  ) {
    this.workerId = identity.workerId;
    this.workspaceId = identity.workspaceId;
    this.keyId = keys.keyId;
    this.owner = {
      userId: keys.owner.userId,
      keyId: keys.owner.keyId,
      fingerprint: keys.owner.fingerprint,
      signingPublicKey: fromBase64Url(keys.owner.signingPublicKey),
    };
    this.ownFingerprint = fingerprint({
      encryptionPublicKey: fromBase64Url(keys.encryptionPublicKey),
      signingPublicKey: fromBase64Url(keys.signingPublicKey),
    });
  }

  /**
   * Builds the trust anchor of a paired, enrolled Worker; `null` (and no subscription) when the
   * state is not paired.
   */
  static async open(input: {
    stateDirectory: string;
    state: WorkerState;
    transport: () => WorkerTrustTransport;
  }): Promise<WorkerTrust | null> {
    const { state } = input;
    if (!state.e2ee || !state.identity) return null;
    const marks = await TrustMarks.open(input.stateDirectory);
    return new WorkerTrust(state.e2ee, state.identity, input.transport(), marks);
  }

  /** A copy of the Worker's encryption seed, for `openBox` / `openRequestRecipient`. Zero it after use. */
  encryptionSeed(): Uint8Array {
    return this.keys.encryptionSeed.slice();
  }

  /** Signs an object clients must attribute to this Worker (`workerObjectStatement`). */
  signObject(parts: {
    table: string;
    parent: string;
    record: string;
    field: string;
    object: Uint8Array;
  }): Promise<Uint8Array> {
    return sign(
      this.keys.signingSeed,
      workerObjectStatement({ workspaceId: this.workspaceId, workerId: this.workerId, ...parts }),
    );
  }

  /**
   * The newest roster, verified against the pinned owner, not older than any roster this Worker has
   * seen (persisted), and still certifying this Worker's key set. Throws `WorkerTrustError`
   * (logged once per reason) when the owner key changed, on rollback, or when this Worker is no
   * longer listed; callers refuse the operation.
   */
  async roster(): Promise<WorkspaceRoster> {
    try {
      const roster = await this.verifiedRoster((await this.transport.trustState()).roster);
      this.loggedFailure = undefined;
      return roster;
    } catch (error) {
      const failure = error instanceof WorkerTrustError ? error : new WorkerTrustError("invalid");
      if (this.loggedFailure !== failure.reason) {
        this.loggedFailure = failure.reason;
        console.warn(failure.message);
      }
      throw failure;
    }
  }

  /**
   * Resolves the signer of a user signature: the pinned owner (role `owner`), or a member listed in
   * the verified roster whose identity (self-signed, active) matches the listed keyId and
   * fingerprint (role `member`). `null` for any other signer or an invalid signature. Throws
   * `WorkerTrustError` when the roster itself cannot be trusted.
   */
  async verifyUser(input: {
    signerKeyId: string;
    message: Uint8Array;
    signature: Uint8Array;
  }): Promise<{ userId: string; role: "owner" | "member" } | null> {
    const roster = await this.roster();
    if (input.signerKeyId === this.owner.keyId) {
      const valid = await verify(this.owner.signingPublicKey, input.message, input.signature);
      return valid ? { userId: this.owner.userId, role: "owner" } : null;
    }

    const member = roster.members.find((entry) => entry.keyId === input.signerKeyId);
    if (!member) return null;
    const identity = await this.identity(input.signerKeyId);
    if (!identity || identity.userId !== member.userId || identity.status !== "active") return null;
    const signingPublicKey = new Uint8Array(identity.signingPublicKey);
    const fingerprintMatches =
      (await fingerprint({
        encryptionPublicKey: new Uint8Array(identity.encryptionPublicKey),
        signingPublicKey,
      })) === member.fingerprint;
    if (!fingerprintMatches) return null;
    if (!(await verify(signingPublicKey, input.message, input.signature))) return null;
    return { userId: member.userId, role: "member" };
  }

  /** The current epoch's workspace owner public key, checked against the verified roster's hash. */
  async ownerPublicKey(): Promise<{ epoch: number; keyId: string; publicKey: Uint8Array }> {
    const state = await this.transport.trustState();
    const roster = await this.roster();
    const entry = roster.epochs.find((row) => row.epoch === roster.epoch);
    const row = state.epochs.find((epoch) => epoch.epoch === roster.epoch);
    if (!entry || !row || row.ownerKeyId !== entry.ownerKeyId) {
      throw new WorkerTrustError("invalid");
    }
    const publicKey = new Uint8Array(row.ownerPublicKey);
    if (toBase64Url(await sha256(publicKey)) !== entry.ownerKeyHash) {
      throw new WorkerTrustError("invalid");
    }
    return { epoch: row.epoch, keyId: row.ownerKeyId, publicKey };
  }

  /** Highest value recorded under `name` (persisted), or 0. */
  highWater(name: string): number {
    return this.marks.highWater(name);
  }

  /** Persistently raises the mark `name` to `value`; never lowers it. */
  advanceHighWater(name: string, value: number): Promise<void> {
    return this.marks.advanceHighWater(name, value);
  }

  /** First-write-wins persisted pin: stores `value` if `name` is unset; true iff the stored value equals it. */
  pin(name: string, value: string): Promise<boolean> {
    return this.marks.pin(name, value);
  }

  /**
   * Persisted one-shot replay guard: true (and recorded until `expiresAt`, ms epoch) if `name` was
   * not claimed or its claim expired; false if an unexpired claim exists.
   */
  claimOnce(name: string, expiresAt: number): Promise<boolean> {
    return this.marks.claimOnce(name, expiresAt);
  }

  /** Stops the trust-state subscription. */
  close(): void {
    this.transport.close();
  }

  private async verifiedRoster(raw: WorkerTrustState["roster"]): Promise<WorkspaceRoster> {
    if (!raw) throw new WorkerTrustError("invalid");
    const highWater = this.marks.highWater("roster");
    if (raw.version < highWater) throw new WorkerTrustError("rollback");
    // The pinned owner alone signs rosters; any other signer means the owner's key was reset.
    if (raw.signerKeyId !== this.owner.keyId) throw new WorkerTrustError("owner_changed");

    const signature = new Uint8Array(raw.signature);
    let roster: WorkspaceRoster;
    const cached = this.verified;
    if (
      cached &&
      cached.roster.version === raw.version &&
      cached.signature === toBase64Url(signature)
    ) {
      roster = cached.roster;
    } else {
      try {
        roster = await verifyRoster({
          version: raw.version,
          body: new Uint8Array(raw.body),
          signature,
          signerKeyId: raw.signerKeyId,
          workspaceId: this.workspaceId,
          owner: this.owner,
          highWater,
        });
      } catch (error) {
        if (error instanceof CryptoError) throw new WorkerTrustError("invalid");
        throw error;
      }
      this.verified = { signature: toBase64Url(signature), roster };
    }

    // Persist every authentic roster, including one that revokes this Worker. Otherwise the relay
    // can replay the preceding roster after a revocation or a restart.
    if (!(await this.marks.pin(`roster:${roster.version}`, toBase64Url(signature)))) {
      throw new WorkerTrustError("invalid");
    }
    await this.marks.advanceHighWater("roster", roster.version);
    // Another concurrent verification may have advanced the mark while this one was in flight.
    if (roster.version < this.marks.highWater("roster")) throw new WorkerTrustError("rollback");
    const ownFingerprint = await this.ownFingerprint;
    const listed = roster.workers.some(
      (worker) =>
        worker.workerId === this.workerId &&
        worker.keyId === this.keyId &&
        worker.fingerprint === ownFingerprint,
    );
    if (roster.version < this.marks.highWater("roster")) throw new WorkerTrustError("rollback");
    if (!listed) throw new WorkerTrustError("not_listed");
    return roster;
  }

  private async identity(keyId: string): Promise<WorkerTrustIdentity | null> {
    const cached = this.identityCache.get(keyId);
    if (cached) return cached;
    const [row] = await this.transport.identities([keyId]);
    if (!row || row.keyId !== keyId) return null;
    const valid = await verifyIdentitySelfSignature({
      keyId: fromBase64Url(row.keyId),
      suite: row.suite,
      encryptionPublicKey: new Uint8Array(row.encryptionPublicKey),
      signingPublicKey: new Uint8Array(row.signingPublicKey),
      signature: new Uint8Array(row.selfSignature),
    }).catch(() => false);
    if (!valid) return null;
    // Self-signed public keys never change for a key ID; status can, so active rows are re-read.
    if (row.status === "retired") this.identityCache.set(keyId, row);
    return row;
  }
}
