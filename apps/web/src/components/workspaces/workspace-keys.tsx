import { useEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "backend/convex/_generated/api";
import type { Id } from "backend/convex/_generated/dataModel";
import { GroupList, Row, RowBlock } from "@/components/harness/group-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useKeyStatus } from "@/lib/crypto/use-key-status";
import { keyManager } from "@/lib/crypto/key-manager";
import {
  acceptWorkspacePhrase,
  approveKeyRequest,
  createAccessLink,
  enableWorkspacePhrase,
  rotateWorkspace,
  TrustRequiredError,
} from "@/lib/crypto/workspace-keys";
import { fetchIdentities } from "@/lib/crypto/public-keys";
import { trust } from "@/lib/crypto/trust-store";
import { currentUserId } from "@/lib/crypto/runtime";
import { TrustPrompt } from "@/components/trust/trust-prompt";

/** Dense workspace key status and owner controls; secrets live only in DOM refs until dismissed. */
export function WorkspaceKeys({ workspaceId }: { workspaceId: Id<"workspaces"> }) {
  const client = useConvex();
  const state = useQuery(api.e2ee.workspaceKeyState, { workspace: workspaceId });
  const nameUserIds = state
    ? [
        ...state.members.map((member) => member.userId),
        ...state.joinRequests.map((request) => request.userId),
      ]
    : [];
  const names = useQuery(
    api.e2ee.identityNames,
    state ? { userIds: [...new Set(nameUserIds)] } : "skip",
  );
  const nameOf = (userId: string) =>
    names?.find((entry) => entry.userId === userId)?.name ?? "Unknown member";
  const status = useKeyStatus();
  const phraseInput = useRef<HTMLInputElement>(null);
  const secretOutput = useRef<HTMLParagraphElement>(null);
  const secret = useRef<string | null>(null);
  const retry = useRef<(() => Promise<void>) | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [prompt, setPrompt] = useState<TrustRequiredError | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  function clearSecret() {
    retry.current = null;
    secret.current = null;
    if (secretOutput.current) secretOutput.current.textContent = "";
    if (phraseInput.current) phraseInput.current.value = "";
    setSecretVisible(false);
  }
  useEffect(() => {
    if (status.state !== "unlocked") clearSecret();
    return () => {
      secret.current = null;
      if (secretOutput.current) secretOutput.current.textContent = "";
    };
  }, [status, workspaceId]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch (error) {
      if (error instanceof TrustRequiredError) {
        retry.current = action;
        setPrompt(error);
      } else setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  function showSecret(value: string) {
    if (keyManager.getSnapshot().state !== "unlocked") return;
    secret.current = value;
    setSecretVisible(true);
    if (secretOutput.current) secretOutput.current.textContent = value;
  }
  async function approve(requestId: Id<"e2ee_join_requests">, userId: string) {
    const identity = (await fetchIdentities([userId])).get(userId);
    if (!identity) throw new Error("Identity unavailable");
    const pinState = await trust.check(userId, identity);
    if (pinState === "first-contact" || pinState === "changed")
      throw new TrustRequiredError(identity, pinState);
    await approveKeyRequest(workspaceId, requestId);
  }
  if (!state) return null;
  const unlocked = status.state === "unlocked";
  const owner = state.role === "owner";
  const ownId = "userId" in status ? status.userId : null;
  const hasKey =
    state.members.find((member) => member.userId === ownId)?.grantedEpoch === state.keyEpoch;
  return (
    <>
      <GroupList
        title="Encryption"
        description="Workspace keys unlock with your account. Removing a member rotates future writes; previously shared content cannot be recalled."
      >
        <Row
          title="Workspace keys"
          description={
            state.keyEpoch ? `Epoch ${state.keyEpoch}` : "Waiting for the owner's unlocked device"
          }
          tag={state.keyEpoch ? "Encrypted" : "Keyless"}
        />
        {state.members.map((member) => (
          <Row
            key={member.userId}
            title={nameOf(member.userId)}
            description={
              !member.keyId
                ? "Account has not set up encryption"
                : member.grantedEpoch === state.keyEpoch
                  ? "Current key granted"
                  : "Needs workspace keys"
            }
            tag={member.role === "owner" ? "Owner" : undefined}
          >
            {owner && member.role !== "owner" && state.keyEpoch && member.keyId ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !unlocked}
                onClick={() =>
                  void run(async () =>
                    showSecret(await createAccessLink(workspaceId, member.userId)),
                  )
                }
              >
                Create access link
              </Button>
            ) : null}
          </Row>
        ))}
        {!owner && state.keyEpoch && !hasKey ? (
          <RowBlock>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !unlocked}
                onClick={() =>
                  void run(async () => {
                    const own = (await fetchIdentities([currentUserId()])).get(currentUserId());
                    if (!own) throw new Error("Identity unavailable");
                    await client.mutation(api.e2ee.requestKeys, {
                      workspace: workspaceId,
                      keyId: own.keyId,
                    });
                  })
                }
              >
                Request keys
              </Button>
            </div>
            {state.phrase ? (
              <form
                className="mt-3 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const words = phraseInput.current?.value ?? "";
                  if (phraseInput.current) phraseInput.current.value = "";
                  void run(() => acceptWorkspacePhrase(workspaceId, words));
                }}
              >
                <Input
                  ref={phraseInput}
                  type="password"
                  autoComplete="off"
                  placeholder="12-word workspace phrase"
                  disabled={!unlocked || busy}
                  aria-label="Workspace key phrase"
                />
                <Button type="submit" size="sm" variant="outline" disabled={!unlocked || busy}>
                  Use phrase
                </Button>
              </form>
            ) : null}
          </RowBlock>
        ) : null}
        {owner && state.keyEpoch ? (
          <Row
            title="Workspace phrase"
            description={
              state.phrase
                ? "Enabled for the current epoch. The phrase cannot be shown again."
                : "Optional generated 12-word key phrase, shown only once."
            }
          >
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !unlocked}
              onClick={() =>
                void run(async () => {
                  if (state.phrase)
                    await client.mutation(api.e2ee.removePhrase, { workspace: workspaceId });
                  else showSecret((await enableWorkspacePhrase(workspaceId)).join(" "));
                })
              }
            >
              {state.phrase ? "Remove phrase" : "Enable phrase"}
            </Button>
          </Row>
        ) : null}
        {owner && state.keyEpoch ? (
          <Row
            title="Recover workspace ownership"
            description="If an account reset lost the owner key, start a new epoch. Historical owner-only data remains unreadable."
          >
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !unlocked}
              onClick={() => void run(() => rotateWorkspace(workspaceId))}
            >
              Rotate epoch
            </Button>
          </Row>
        ) : null}
        <RowBlock className={secretVisible ? undefined : "hidden"}>
          <p className="mb-2 text-sm text-muted-foreground">
            Share outside Radium. This secret is shown once.
          </p>
          <p ref={secretOutput} className="break-all text-sm" />
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (secret.current) void navigator.clipboard.writeText(secret.current);
              }}
            >
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSecret}>
              Done
            </Button>
          </div>
        </RowBlock>
        {failed ? (
          <RowBlock>
            <p role="alert" className="text-sm text-destructive">
              Key exchange failed. Unlock your account and verify identities before trying again.
            </p>
          </RowBlock>
        ) : null}
        {!unlocked && state.keyEpoch ? (
          <RowBlock>
            <p className="text-sm text-muted-foreground">
              Unlock encryption in the account menu to exchange workspace keys.
            </p>
          </RowBlock>
        ) : null}
      </GroupList>
      {state.invites.length ? (
        <GroupList title="Access links">
          {state.invites.map((invite) => (
            <Row
              key={invite.inviteId}
              title={invite.invitedUserId}
              description={`Expires ${new Date(invite.expiresAt).toLocaleDateString()}`}
            >
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client.mutation(api.e2ee.revokeInvite, { inviteId: invite.inviteId });
                  })
                }
              >
                Revoke
              </Button>
            </Row>
          ))}
        </GroupList>
      ) : null}
      {state.joinRequests.length ? (
        <GroupList title="Pending key requests">
          {state.joinRequests
            .filter((request) => request.source === "request")
            .map((request) => (
              <Row
                key={request._id}
                title={nameOf(request.userId)}
                description={`Key ${request.keyId}`}
                tag="Needs approval"
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !unlocked}
                  onClick={() => void run(() => approve(request._id, request.userId))}
                >
                  Approve
                </Button>
                {owner ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await client.mutation(api.e2ee.dismissJoinRequest, {
                          requestId: request._id,
                        });
                      })
                    }
                  >
                    Deny
                  </Button>
                ) : null}
              </Row>
            ))}
        </GroupList>
      ) : null}
      {prompt ? (
        <TrustPrompt
          error={prompt}
          onApproved={() => {
            setPrompt(null);
            const action = retry.current;
            retry.current = null;
            if (action) void run(action);
          }}
          onDenied={() => {
            retry.current = null;
            setPrompt(null);
          }}
        />
      ) : null}
    </>
  );
}
