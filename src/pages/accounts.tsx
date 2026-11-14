import { useEffect, useState } from "react";
import { EllipsisIcon, MailIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { accountWideStatus, type AccountView } from "../accounts/model";
import { SERVICES, serviceInfo, type Service } from "../google/services";
import type { AccountsAlert } from "../accounts/flow";
import { OwnerFrame, PageHeader } from "./frame";
import type { Frame } from "./page";
import { postAction, type Outcome } from "./actions";

function actionMessage(outcome: Outcome): string | null {
  switch (outcome) {
    case "ok":
      return null;
    case "not_found":
      return "This account no longer exists. Nothing changed. Reload the page.";
    case "invalid":
      return "Use a name with 1 to 100 characters.";
    case "unavailable":
      return "Couldn't reach the database. Nothing changed. Try again in a minute.";
    default:
      return "Couldn't confirm the change. Reload the page to see whether it happened.";
  }
}
function alertMessage(alert: AccountsAlert | null): string | null {
  if (!alert) return null;
  switch (alert.kind) {
    case "connected":
    case "reconnected": {
      const start = `${alert.kind === "connected" ? "Connected" : "Reconnected"} ${alert.address}.`;
      if (alert.incomplete.length) {
        const names = new Intl.ListFormat("en", { type: "conjunction" }).format(
          alert.incomplete.map((service) => serviceInfo[service].name),
        );
        return `${start} Google didn't grant all of ${names}'s access, so agents can't use ${names} on it. Reconnect and check every box on Google's screen.`;
      }
      return alert.kind === "connected"
        ? start
        : `${start} Every connection keeps the permissions it had for this account.`;
    }
    case "no_access":
      return "Nothing changed. Google didn't grant any of the access you chose. Try again and check the boxes on Google's screen.";
    case "already_connected":
      return `${alert.address} is already connected. Reconnect it from its row.`;
    case "address_taken":
      return `Nothing changed. Another Google account already uses ${alert.address} here. Reconnect or remove ${alert.name} first.`;
    case "wrong_account":
      return `Nothing changed. You signed in to Google as ${alert.signedIn}, but this reconnect is for ${alert.target}.`;
    case "changed":
      return `Nothing changed. ${alert.address} changed while you were at Google. Try again.`;
    case "didnt_finish":
      return "Didn't finish. It expired, was cancelled, or started in another browser. Nothing changed. Try again.";
    case "client_refused":
      return "Google refused this server's OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Nothing changed.";
    case "google_down":
      return "Google didn't answer. Nothing changed. Try again in a minute.";
    case "no_refresh_token":
      return "Google didn't return lasting access. Nothing changed. Try again.";
    case "unconfirmed":
      return actionMessage("unknown");
    case "removed":
      return `Removed ${alert.address}.`;
    case "removed_unconfirmed":
      return `Removed ${alert.address}. Google didn't confirm the disconnect.`;
  }
}
const fixable = (account: AccountView) =>
  accountWideStatus(account)?.kind === "needs_reconnect" ||
  (!accountWideStatus(account) &&
    SERVICES.some((service) => {
      const access = account.services[service];
      return access.status.kind === "missing_access" && access.granted > 0;
    }));
export function AccountStatusText({ account }: { account: AccountView }) {
  const status = accountWideStatus(account);
  if (status?.kind === "unreadable")
    return (
      <span className="text-muted-foreground">Can't read its stored access. Check TOKEN_KEY.</span>
    );
  if (status) {
    const reconnect = status.kind === "needs_reconnect";
    return (
      <span className="text-muted-foreground">
        <span className={reconnect ? "text-destructive" : "text-foreground"}>
          {reconnect ? "Needs reconnect" : "Blocked by admin"}.
        </span>{" "}
        {reconnect
          ? "Google stopped accepting this server's access. Reconnect to restore it."
          : "The organization's admin blocked this app. The server checks again at most every 10 minutes, when an agent uses this account."}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-2">
      {SERVICES.map((service) => {
        const access = account.services[service];
        const missing = access.status.kind === "missing_access";
        const partial = missing && access.granted > 0;
        return (
          <span key={service} className="flex items-baseline gap-2">
            <span className="text-muted-foreground">{serviceInfo[service].name}</span>
            <span className={missing ? "text-muted-foreground" : "text-foreground"}>
              {partial ? (
                <>
                  <span className="text-destructive">Missing access.</span> Google granted{" "}
                  {access.granted} of {access.required} permissions {serviceInfo[service].name}{" "}
                  needs. Reconnect and check every box.
                </>
              ) : missing ? (
                "Not connected"
              ) : (
                "Ready"
              )}
            </span>
          </span>
        );
      })}
    </span>
  );
}
function Address({ account }: { account: AccountView }) {
  return (
    <>
      {account.email}
      {account.workspace && <span className="text-muted-foreground"> · Workspace</span>}
    </>
  );
}
export function AccountsPage({
  frame,
  accounts,
  alert,
}: {
  readonly frame: Frame;
  readonly accounts: ReadonlyArray<AccountView>;
  readonly alert: AccountsAlert | null;
}) {
  const [message, setMessage] = useState(
    () =>
      alert && {
        text: alertMessage(alert),
        warning:
          ((alert.kind === "connected" || alert.kind === "reconnected") &&
            alert.incomplete.length > 0) ||
          !["connected", "reconnected", "removed", "already_connected"].includes(alert.kind),
      },
  );
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<AccountView | "new" | null>(null);
  const [dialog, setDialog] = useState<{ account: AccountView; action: "name" | "remove" } | null>(
    null,
  );
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setBusy(false);
        setConnecting(null);
      }
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  const begin = async (services: readonly Service[], account?: AccountView) => {
    setBusy(true);
    const result = await postAction(
      account ? `/accounts/${account.id}/reconnect` : "/accounts/connect",
      services.map((service) => ["services", service]),
    );
    if (result.outcome === "ok" && result.url) {
      window.location.assign(result.url);
      return;
    }
    setMessage({
      text: actionMessage(result.outcome === "ok" ? "unknown" : result.outcome),
      warning: true,
    });
    setBusy(false);
    setConnecting(null);
  };
  const reconnect = (account: AccountView, mobile = false) => (
    <Button
      variant="outline"
      className={mobile ? "w-full" : undefined}
      disabled={busy}
      onClick={() => setConnecting(account)}
    >
      Reconnect
    </Button>
  );
  const menu = (account: AccountView) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label={`Actions for ${account.name}`}
          disabled={busy}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setDialog({ account, action: "name" })}>
          Rename
        </DropdownMenuItem>
        {!fixable(account) && (
          <DropdownMenuItem onSelect={() => setConnecting(account)}>Reconnect</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => setDialog({ account, action: "remove" })}
        >
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <OwnerFrame frame={frame}>
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <PageHeader
            title="Accounts"
            description="Google accounts your agents can use. Each connection sees only the ones you grant."
          />
          <Button disabled={busy} onClick={() => setConnecting("new")}>
            Connect a Google account
          </Button>
        </div>
        {message && (
          <Alert role="status" variant={message.warning ? "warning" : "default"}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}
        {accounts.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MailIcon />
              </EmptyMedia>
              <EmptyTitle>No Google accounts yet</EmptyTitle>
              <EmptyDescription>
                Connect a Gmail or Workspace account so your agents can use it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {["Name", "Account", "Status"].map((title, i) => (
                      <TableHead
                        key={title}
                        className={cn("font-normal text-muted-foreground", i === 0 && "pl-0")}
                      >
                        {title}
                      </TableHead>
                    ))}
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.map((account) => (
                    <TableRow key={account.id} className="hover:bg-transparent">
                      <TableCell className="max-w-40 py-4 pl-0 align-top font-medium whitespace-normal wrap-anywhere">
                        {account.name}
                      </TableCell>
                      <TableCell className="max-w-56 py-4 align-top whitespace-normal wrap-anywhere">
                        <Address account={account} />
                      </TableCell>
                      <TableCell className="max-w-64 py-4 align-top whitespace-normal">
                        <AccountStatusText account={account} />
                      </TableCell>
                      <TableCell className="py-4 pr-0 align-top">
                        <div className="flex items-center justify-end gap-2">
                          {fixable(account) && reconnect(account)}
                          {menu(account)}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <ItemGroup className="gap-0 md:hidden">
              {accounts.map((account, i) => (
                <div key={account.id}>
                  {i > 0 && <ItemSeparator className="my-0" />}
                  <Item className="items-start border-0 px-0 py-6">
                    <ItemContent className="min-w-0 gap-1">
                      <ItemTitle className="line-clamp-none text-base wrap-anywhere">
                        {account.name}
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none wrap-anywhere">
                        <Address account={account} />
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="-mt-1.5 -mr-2">{menu(account)}</ItemActions>
                    <ItemContent className="basis-full gap-3">
                      <ItemDescription className="line-clamp-none">
                        <AccountStatusText account={account} />
                      </ItemDescription>
                      {fixable(account) && reconnect(account, true)}
                    </ItemContent>
                  </Item>
                </div>
              ))}
            </ItemGroup>
          </>
        )}
      </div>
      {connecting && (
        <ServiceDialog
          key={connecting === "new" ? "new" : connecting.id}
          account={connecting === "new" ? undefined : connecting}
          busy={busy}
          close={() => setConnecting(null)}
          submit={(services) => void begin(services, connecting === "new" ? undefined : connecting)}
        />
      )}
      {dialog && (
        <AccountDialog
          key={`${dialog.account.id}-${dialog.action}`}
          {...dialog}
          close={() => setDialog(null)}
        />
      )}
    </OwnerFrame>
  );
}
function ServiceDialog({
  account,
  busy,
  close,
  submit,
}: {
  account?: AccountView;
  busy: boolean;
  close: () => void;
  submit: (services: readonly Service[]) => void;
}) {
  const [chosen, setChosen] = useState<readonly Service[]>(() =>
    account ? SERVICES.filter((service) => account.services[service].granted > 0) : [],
  );
  const descriptions: Record<Service, string> = {
    gmail: "Read, draft, send, and organize mail.",
    calendar: "See calendars and events, create and change events, and answer invitations.",
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosen.length && !busy) submit(chosen);
          }}
        >
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">
              {account ? `Reconnect ${account.name}` : "Connect a Google account"}
            </DialogTitle>
            <DialogDescription>
              Choose what agents can reach in this account. Google asks you to allow each one.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {SERVICES.map((service) => (
              <Field key={service} orientation="horizontal">
                <Checkbox
                  id={`service-${service}`}
                  checked={chosen.includes(service)}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setChosen((previous) =>
                      checked === true
                        ? [...previous, service]
                        : previous.filter((s) => s !== service),
                    )
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor={`service-${service}`}>
                    {serviceInfo[service].name}
                  </FieldLabel>
                  <FieldDescription>{descriptions[service]}</FieldDescription>
                </FieldContent>
              </Field>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            A Workspace organization can block Calendar for apps it doesn't trust. If Google shows a
            page saying this app is blocked, connect again without Calendar.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !chosen.length}>
              {busy ? "Continuing…" : "Continue to Google"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function AccountDialog({
  account,
  action,
  close,
}: {
  account: AccountView;
  action: "name" | "remove";
  close: () => void;
}) {
  const [name, setName] = useState(account.name),
    [disconnect, setDisconnect] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    const result = await postAction(
      `/accounts/${account.id}/${action}`,
      action === "name" ? { name } : disconnect ? { disconnect: "1" } : {},
    );
    if (result.outcome === "ok") {
      window.location.reload();
      return;
    }
    setMessage(actionMessage(result.outcome));
    setBusy(false);
  };
  const feedback = message && (
    <Alert role="status" variant="warning">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
  if (action === "name")
    return (
      <Dialog open onOpenChange={(open) => !open && !busy && close()}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="flex flex-col gap-6"
          >
            <DialogHeader>
              <DialogTitle className="wrap-anywhere">Rename {account.name}</DialogTitle>
              <DialogDescription>Change the name shown to you and your agents.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rename">Name</Label>
              <Input
                id="rename"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                required
                disabled={busy}
              />
            </div>
            {feedback}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    );
  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && close()}>
      <AlertDialogContent>
        <AlertDialogHeader className="place-items-start text-left">
          <AlertDialogTitle className="wrap-anywhere">Remove {account.name}?</AlertDialogTitle>
          <AlertDialogDescription className="wrap-anywhere">
            This removes {account.email} from the server and deletes its stored access and every
            connection's permissions for it. If you connect it again, it starts with no access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal">
          <Checkbox
            id="disconnect"
            checked={disconnect}
            onCheckedChange={(checked) => setDisconnect(checked === true)}
            disabled={busy}
          />
          <FieldContent>
            <FieldLabel htmlFor="disconnect">Also disconnect this app in Google</FieldLabel>
            <FieldDescription>
              Google then ends this account's access for everything that uses this server's OAuth
              client.
            </FieldDescription>
          </FieldContent>
        </Field>
        {feedback}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            className="text-red-800 dark:text-red-300"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "Removing…" : "Remove"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
