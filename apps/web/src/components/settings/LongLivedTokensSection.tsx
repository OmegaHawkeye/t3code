import { PlusIcon } from "lucide-react";
import { memo, useState } from "react";
import type { AuthLongLivedTokenResult, AuthMcpClientAccess } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  createServerLongLivedToken,
  type ServerClientSessionRecord,
} from "../../environments/primary/auth";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { longLivedTokenAccessLabel } from "./ConnectionsSettings.logic";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";

const ACCESS_OPTIONS: ReadonlyArray<{
  readonly value: AuthMcpClientAccess;
  readonly label: string;
}> = [
  { value: "read-only", label: "Read only" },
  { value: "approval-required", label: "Approval required" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "auto", label: "Auto" },
  { value: "full-access", label: "Full access" },
];

const accessLabel = (access: AuthMcpClientAccess) =>
  ACCESS_OPTIONS.find((option) => option.value === access)?.label ?? access;

const tokenLabel = ({ client: { label }, subject }: ServerClientSessionRecord) => label ?? subject;

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

const CreateTokenDialog = memo(function CreateTokenDialog() {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [isCreating, setIsCreating] = useState(false);
  // Held only while the dialog is open: the server never returns the token again.
  const [created, setCreated] = useState<AuthLongLivedTokenResult | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => toastManager.add({ type: "success", title: "Token copied" }),
  });

  const reset = () => {
    setLabel("");
    setAccess("approval-required");
    setCreated(null);
  };

  const handleCreate = async () => {
    setIsCreating(true);
    let result: AuthLongLivedTokenResult | null = null;
    const settled = await settlePromise(async () => {
      result = await createServerLongLivedToken({ label, access });
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create token",
          description: error instanceof Error ? error.message : "Failed to create token.",
        }),
      );
    } else {
      setCreated(result);
    }
    setIsCreating(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Create token
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Token created</DialogTitle>
              <DialogDescription>Copy this token now. It won't be shown again.</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <code className="block break-all rounded-md border border-border/50 bg-muted/50 p-2 font-mono text-xs">
                {created.token}
              </code>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={() => copyToClipboard(created.token)}>
                {isCopied ? "Copied" : "Copy token"}
              </Button>
              <DialogClose render={<Button />}>Done</DialogClose>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create long-lived token</DialogTitle>
              <DialogDescription>
                A bearer token for MCP clients that cannot sign in with OAuth. It is valid for 360
                days and is not renewed.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">Label</span>
                <Input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="e.g. CI runner"
                  disabled={isCreating}
                  autoFocus
                />
              </label>
              <div className="mt-3">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Access level
                </span>
                <Select
                  value={access}
                  onValueChange={(value) => {
                    const next = ACCESS_OPTIONS.find((option) => option.value === value);
                    if (next) setAccess(next.value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Access level" disabled={isCreating}>
                    <SelectValue>{accessLabel(access)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {ACCESS_OPTIONS.map((option) => (
                      <SelectItem hideIndicator key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </DialogPanel>
            <DialogFooter variant="bare">
              <DialogClose render={<Button variant="outline" disabled={isCreating} />}>
                Cancel
              </DialogClose>
              <Button
                disabled={isCreating || label.trim().length === 0}
                onClick={() => void handleCreate()}
              >
                {isCreating ? "Creating…" : "Create token"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
});

export const LongLivedTokensSection = memo(function LongLivedTokensSection({
  tokens,
  canWrite,
  revokingSessionId,
  onRevoke,
}: {
  readonly tokens: ReadonlyArray<ServerClientSessionRecord>;
  readonly canWrite: boolean;
  readonly revokingSessionId: string | null;
  readonly onRevoke: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
}) {
  return (
    <FoldedSettingsSection
      id="long-lived-tokens"
      title="Long-lived tokens"
      summary={`${tokens.length} ${tokens.length === 1 ? "token" : "tokens"}`}
      control={canWrite ? <CreateTokenDialog /> : undefined}
    >
      {tokens.length === 0 ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">No long-lived tokens.</p>
        </div>
      ) : (
        tokens.map((token) => (
          <div key={token.sessionId} className={ITEM_ROW_CLASSNAME}>
            <div className={ITEM_ROW_INNER_CLASSNAME}>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="text-sm font-medium text-foreground">{tokenLabel(token)}</h3>
                <p className="text-xs text-muted-foreground">
                  {longLivedTokenAccessLabel(token.scopes)} · Created{" "}
                  {formatTimestamp(token.issuedAt)} · Expires {formatTimestamp(token.expiresAt)}
                </p>
              </div>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={!canWrite || revokingSessionId === token.sessionId}
                onClick={() => onRevoke(token.sessionId)}
              >
                {revokingSessionId === token.sessionId ? "Revoking…" : "Revoke"}
              </Button>
            </div>
          </div>
        ))
      )}
    </FoldedSettingsSection>
  );
});
