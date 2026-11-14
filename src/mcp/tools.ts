import {
  Attachments,
  alsoOf,
  uploadsOf,
  attachingTools,
  attachmentValues,
  attachedFiles,
  attachmentsDescription,
  attachmentsExpect,
  type Item,
} from "./attachments";
import { createLink } from "../uploads/store";
import { UPLOAD_PATH } from "../uploads/link";
import type { Tool as McpTool } from "@modelcontextprotocol/server";
import {
  fileText,
  filesText,
  isoSeconds,
  viewDate,
  type ViewNote,
  type ViewValue,
} from "../approvals/model";
import { getApproval } from "../approvals/result";
import { Data, Effect, Result, Schema, SchemaIssue } from "effect";
import type { Unavailable } from "../db";
import { accountMessage } from "../accounts/model";
import { listVisibleAccounts } from "../accounts/store";
import { findAttachment, partBytes } from "../google/attachment";
import { MAX_ATTACHMENT_BYTES, WithFile, type Takes } from "./file";
import { BodyBudget, LIMIT, placeOf, readThread, textOf } from "../google/thread";
import { GmailId, listLabels, MAX_ITEMS, searchThreads, threadSummary } from "../google/gmail";
import {
  changeLabels,
  labelChangeNotes,
  labelChangeValues,
  LABELS_EXPECT,
  MAX_LABELS,
  REFUSED,
  REFUSED_ADD,
} from "../google/organize";
import { deleteMessages, messageValues, restoreMessages, trashMessages } from "../google/trash";
import { readListedTools } from "../permissions/store";
import type { CallContext } from "./call";
import {
  creating,
  notSendable,
  messageTooLarge,
  notReadable,
  tooLarge,
  ToolFailure,
} from "./failures";
import { GROUP_SERVICE, type Group } from "./groups";
import { SERVICES, type Service } from "../google/services";
import {
  CalendarId,
  calendarContext,
  readableCalendar,
  listCalendars,
  MAX_CALENDARS,
  MAX_CALENDARS_CHARACTERS,
} from "../google/calendar";
import {
  TimeText,
  ZoneName,
  parseTime,
  rangeOf,
  viewTime,
  zonedIso,
} from "../google/calendar-time";
import {
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  MAX_EVENT_CALENDARS,
  MAX_EVENT_QUERY,
  MAX_EVENT_PAGE,
  EventId,
  eventView,
  readEvent,
  searchEvents,
} from "../google/events";
import type { Created } from "../once/store";
import { createDraft, readDraft, uploadDraft } from "../google/draft";
import {
  MAX_SUBJECT,
  mailboxText,
  messageText,
  parseMailbox,
  rawMessage,
  mixedMessage,
  type Mailbox,
  type Outgoing,
} from "../google/mail";
import { replyPlan, type ReplyPlan } from "../google/reply";
import { normalizeEmail } from "../owner/owner";
import {
  MAX_BODY_PARTS,
  MAX_REPLY_HEADER,
  MAX_TEXT,
  PAGE_BODY_BYTES,
  shorten,
} from "../google/bounds";
import { sendExisting, sendStaged } from "../google/send";
import { forwardFiles, forwardPlan, MAX_FORWARD_FILES, MAX_FORWARD_BYTES } from "../google/forward";
import { addresses, header, readMessage, attachmentParts, otherParts } from "../google/message";
type AccountExecution<A> =
  | {
      run: (
        send: Send,
        account: { email: string },
        args: A,
        takes: Takes,
      ) => Effect.Effect<unknown, ToolFailure>;
      create?: never;
      unknown?: never;
    }
  | {
      create: (
        send: Send,
        account: { email: string },
        args: A,
        confirm: Confirm,
        sources: Sources,
      ) => Effect.Effect<Created, ToolFailure>;
      defaults: Readonly<Partial<A>>;
      unknown: (email: string, until: number, args: A) => string;
      run?: never;
    };
export class ViewUnavailable extends Data.TaggedError("ViewUnavailable") {}
/** What every tool with a setting takes. A tool reads its own fields through its typed definition. */
export type DecodedArgs = { readonly account: string };
/** A name that the tool list accepted. The list below is the only list of tool names. */
export type AccountTool = string & { readonly __accountTool: unique symbol };
/** Tools supply a request, never receive a credential or token store. */
export type Send = (
  build: (accessToken: string, signal: AbortSignal) => Request,
) => Effect.Effect<Response, ToolFailure>;
export interface Uploaded {
  filename: string;
  type: string;
  size: number;
  charset?: string | null;
  bytes: Effect.Effect<Uint8Array<ArrayBuffer>, ToolFailure>;
}
export interface Sources {
  from: (account: string) => Send;
  uploads: ReadonlyMap<string, Uploaded>;
}
export type Sending = Send & { readonly __sending: unique symbol };
export type Confirm = { readonly check: Effect.Effect<Sending, ToolFailure>; readonly late: Send };
/** What tools/list tells a client about a tool. A tool that changes mail says so. */
export type ToolAnnotations =
  | { readOnlyHint: true }
  | { readOnlyHint: false; destructiveHint: boolean; idempotentHint: boolean };
export type Tool =
  | {
      kind: "plain";
      name: "list_accounts" | "get_approval" | "create_upload_link";
      label: string;
      inputSchema?: McpTool["inputSchema"];
      description: string;
      annotations: ToolAnnotations;
      run: (
        ctx: CallContext,
        args: Record<string, unknown> | undefined,
      ) => Effect.Effect<unknown, Unavailable | ToolFailure>;
    }
  | ({
      kind: "account";
      name: AccountTool;
      label: string;
      group: Group;
      /**
       * True when neither the owner nor another tool can revert what one call did: a sent mail, a
       * message deleted for good. False when it can be reverted: a draft can be deleted, and a
       * message in the trash can be restored for 30 days. The connection's page names the tools
       * that say true before it sets them to Allowed.
       */
      irreversible: boolean;
      permissionDescription: string;
      description: string;
      annotations: ToolAnnotations;
      input: Schema.Codec<DecodedArgs, unknown>;
      /** What each field must be, for the message of invalid_arguments. */
      expects: Readonly<Record<string, string>>;
      also?: (args: DecodedArgs) => ReadonlyArray<{ account: string; tool: string }>;
      uploads?: (args: DecodedArgs) => ReadonlyArray<string>;
      view: {
        action: string;
        joiner: string;
        empty: string;
        /** Only send_draft may disable the digest equality check and send the current Gmail draft. */
        asItIs?: true;
        /** Sentences that the page says about this call, from its arguments alone. */
        notes?: (args: DecodedArgs) => ReadonlyArray<ViewNote>;
        values: (
          args: DecodedArgs,
          send: Send,
          sources: Sources,
        ) => Effect.Effect<ReadonlyArray<ViewValue>, ViewUnavailable | ToolFailure>;
      };
    } & AccountExecution<DecodedArgs>);
type AccountDefinition<A extends DecodedArgs> = {
  name: string;
  label: string;
  group: Group;
  irreversible: boolean;
  permissionDescription: string;
  description: string;
  annotations: ToolAnnotations;
  input: Schema.Codec<A, unknown>;
  expects: Readonly<Record<keyof A & string, string>>;
  also?: (args: A) => ReadonlyArray<{ account: string; tool: string }>;
  uploads?: (args: A) => ReadonlyArray<string>;
  view: {
    action: string;
    joiner: string;
    /** Only send_draft may disable the digest equality check and send the current Gmail draft. */
    asItIs?: true;
    /** Sentences that the page says about this call, from its arguments alone. */
    notes?: (args: A) => ReadonlyArray<ViewNote>;
    values: (
      args: A,
      send: Send,
      sources: Sources,
    ) => Effect.Effect<ReadonlyArray<ViewValue>, ViewUnavailable | ToolFailure>;
  };
} & AccountExecution<A>;
// The runner passes a tool only the arguments that the tool's own input decoded.
const accountTool = <A extends DecodedArgs>(definition: AccountDefinition<A>) =>
  ({
    kind: "account",
    ...definition,
    // The page shows this when a call has no values beyond its sentence; every tool says the same.
    view: {
      ...definition.view,
      empty: "This call has no other values. The sentence above is the whole call.",
    },
  }) as unknown as Extract<Tool, { kind: "account" }>;
/** The field that fails a tool's input, or null when the arguments are not an object. */
export const decodeArgs = (
  tool: Extract<Tool, { kind: "account" }>,
  args: unknown,
): { ok: true; value: DecodedArgs } | { ok: false; field: string | null; expects?: string } => {
  const result = Schema.decodeUnknownResult(tool.input, {
    onExcessProperty: tool.create ? "error" : "ignore",
  })(args);
  if (Result.isSuccess(result)) return { ok: true, value: result.success };
  let issue: unknown = result.failure.issue;
  while (typeof issue === "object" && issue !== null) {
    if ("path" in issue && Array.isArray(issue.path) && typeof issue.path[0] === "string") {
      const extra =
        "issue" in issue &&
        SchemaIssue.isIssue(issue.issue) &&
        issue.issue._tag === "UnexpectedKey";
      return {
        ok: false,
        field: issue.path[0],
        ...(extra ? { expects: "left out: this tool has no such field" } : {}),
      };
    }
    issue =
      "issues" in issue && Array.isArray(issue.issues)
        ? issue.issues[0]
        : "issue" in issue
          ? issue.issue
          : null;
  }
  return { ok: false, field: null };
};
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;
const MAX_QUERY = 2000;
const MAX_PAGE = 500;
const LabelIds = Schema.Array(
  Schema.String.check(
    Schema.isBetweenLength(1, 100),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
    Schema.makeFilter((id) => !REFUSED.has(id)),
  ),
).check(Schema.isMaxLength(MAX_LABELS));
const labelChange = (args: {
  threads: readonly string[];
  add?: readonly string[];
  remove?: readonly string[];
}) => ({ threads: args.threads, add: args.add ?? [], remove: args.remove ?? [] });
const Mailboxes = Schema.Array(
  Schema.String.check(Schema.makeFilter((value) => parseMailbox(value) !== null)),
);
const Subject = Schema.String.check(
  Schema.isMaxLength(MAX_SUBJECT),
  // oxlint-disable-next-line no-control-regex -- Input subjects cannot contain header controls.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]*$/),
);
const DraftInput = Schema.Struct({
  account: Schema.String,
  to: Schema.optionalKey(Mailboxes),
  cc: Schema.optionalKey(Mailboxes),
  bcc: Schema.optionalKey(Mailboxes),
  subject: Schema.optionalKey(Subject),
  body: Schema.String,
  attachments: Schema.optionalKey(Attachments),
  reply_to: Schema.optionalKey(GmailId),
  reply_all: Schema.optionalKey(Schema.Boolean),
  duplicate: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 }))),
}).check(
  Schema.makeFilter((args) => {
    if (
      args.reply_all &&
      (!args.reply_to || [args.to, args.cc, args.bcc].some((list) => list?.length))
    )
      return { path: ["reply_all"], issue: "requires reply_to and no given recipients" };
    if (args.reply_to && args.subject)
      return { path: ["subject"], issue: "cannot be given for a reply" };
    return true;
  }),
);
type DraftArgs = typeof DraftInput.Type;
const draftRecipients = (args: Pick<DraftArgs, "to" | "cc" | "bcc">) => ({
  to: (args.to ?? []).map((text) => parseMailbox(text)!),
  cc: (args.cc ?? []).map((text) => parseMailbox(text)!),
  bcc: (args.bcc ?? []).map((text) => parseMailbox(text)!),
});
const givenRecipients = (boxes: { to: Mailbox[]; cc: Mailbox[]; bcc: Mailbox[] }) =>
  boxes.to.length || boxes.cc.length || boxes.bcc.length ? boxes : null;
const draftMail = (
  args: Pick<DraftArgs, "body" | "subject">,
  boxes: ReturnType<typeof draftRecipients>,
  plan?: ReplyPlan,
): Outgoing => ({
  ...boxes,
  ...(plan
    ? { to: plan.to, cc: plan.cc, inReplyTo: plan.inReplyTo, references: plan.references }
    : {}),
  subject: plan?.subject ?? args.subject ?? "",
  body: args.body,
});
const MessagesInput = Schema.Struct({
  account: Schema.String,
  messages: Schema.Array(GmailId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ITEMS),
    Schema.isUnique(),
  ),
});
const SearchEventsInput = Schema.Struct({
  account: Schema.String,
  calendars: Schema.optionalKey(
    Schema.Array(CalendarId).check(Schema.isBetweenLength(1, MAX_EVENT_CALENDARS)),
  ),
  from: TimeText,
  to: TimeText,
  time_zone: Schema.optionalKey(ZoneName),
  query: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, MAX_EVENT_QUERY))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_EVENT_LIMIT })),
  ),
  page: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, MAX_EVENT_PAGE))),
}).check(
  Schema.makeFilter((args) => {
    if (args.page !== undefined && (args.calendars?.length ?? 1) > 1)
      return { path: ["page"], issue: "requires exactly one calendar" };
    if (
      args.time_zone !== undefined ||
      (parseTime(args.from).kind === "instant") === (parseTime(args.to).kind === "instant")
    ) {
      const range = rangeOf(args.from, args.to, args.time_zone ?? "UTC");
      if (Result.isFailure(range)) return { path: ["to"], issue: range.failure.field!.expects };
    }
    return true;
  }),
);
const zoneExpects = "UTC or an IANA zone name with a slash, such as America/Bogota";
const timeExpects =
  "a valid date or date-time in years 1900 to 2999: YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS[.fff]], with an optional Z or ±HH:MM offset";
const messagesExpects = {
  account: "a string",
  messages: `a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned`,
};

const draftValues = (
  args: { body: string; duplicate?: number },
  mail: Outgoing,
  boxes: ReturnType<typeof draftRecipients>,
  plan?: ReplyPlan,
  files: readonly ViewValue[] = [],
): ViewValue[] => {
  const values: ViewValue[] = [];
  if (plan) {
    values.push(
      {
        name: "Answers a message from",
        text: shorten(plan.answered.from, 1000),
        from: "gmail",
      },
      { name: "Its subject", text: shorten(plan.answered.subject, 1000), from: "gmail" },
      { name: "Its date", text: viewDate(plan.answered.date), from: "gmail" },
    );
  }
  for (const [name, recipients] of [
    ["To", mail.to],
    ["Cc", mail.cc],
    ["Bcc", mail.bcc],
  ] as const)
    if (recipients.length)
      values.push({
        name,
        text: recipients.map(mailboxText).join(", "),
        from: plan && !givenRecipients(boxes) ? "gmail" : "agent",
      });
  if (mail.subject)
    values.push({ name: "Subject", text: mail.subject, from: plan ? "gmail" : "agent" });
  values.push(...files);
  if (args.duplicate !== undefined)
    values.push({
      name: "Duplicate",
      text: `${args.duplicate} (a deliberate copy of an earlier call)`,
      from: "agent",
    });
  values.push({ name: "Body", text: args.body, from: "agent" });
  return values;
};

const draftExpects = {
  attachments: attachmentsExpect,
  account: "a string",
  to: "a list of mailboxes, empty or absent when reply_all is true",
  cc: "a list of mailboxes, empty or absent when reply_all is true",
  bcc: "a list of mailboxes, empty or absent when reply_all is true",
  subject: `a string of at most ${MAX_SUBJECT} characters without control characters, empty or absent for a reply`,
  body: "a string",
  reply_to:
    "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account; a reply requires an empty or absent subject",
  reply_all: "a boolean, true only with reply_to and no given recipients",
  duplicate: "a whole number from 2 to 100",
};

const repeatSend =
  "Repeating: a call with the same arguments as a call of the last 7 days is the same call. It never sends a second message. It returns the first call's result with repeat_of, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new message. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail.";
const deliberateSend =
  " To send one more message with the same content on purpose, add duplicate: 2 (then 3).";
const unknownSend = (
  email: string,
  until: number,
  args: { duplicate?: number; attachments?: readonly Item[] },
) => {
  const next = (args.duplicate ?? 1) + 1;
  return `The server does not know whether this mail went out from ${email}. Ask the owner to look in Sent. If it is not there, it may still be in Drafts, and the owner can send it from Gmail. Until ${isoSeconds(until)}, repeating this call does not send it again.${next <= 100 ? ` Only if the owner says that it is in neither place, call again with duplicate: ${next}${uploadsOf(args.attachments).length ? " and a new upload of each file" : ""}.` : ""}`;
};
const sendRefused = (status: number) =>
  status === 400 ? notSendable(null) : new ToolFailure({ code: "google_unavailable" });
const composedDraft = (
  send: Send,
  mail: Outgoing,
  items: readonly Item[] | undefined,
  sources: Sources,
  thread?: string,
  refused?: (status: number) => ToolFailure,
) =>
  Effect.gen(function* () {
    if (!items?.length)
      return createDraft(
        send,
        { raw: rawMessage(messageText(mail)), ...(thread ? { thread } : {}) },
        refused,
      );
    const files = yield* attachedFiles(
      items,
      sources,
      new TextEncoder().encode(mail.body).byteLength,
    );
    return uploadDraft(send, {
      message: mixedMessage(mail, files),
      ...(thread ? { thread } : {}),
    });
  });
const sendMail = (
  send: Send,
  confirm: Confirm,
  mail: Outgoing,
  items: readonly Item[] | undefined,
  sources: Sources,
  thread?: string,
) =>
  composedDraft(send, mail, items, sources, thread, sendRefused).pipe(
    Effect.flatMap((stage) => sendStaged(confirm, stage)),
  );
const replyExpects =
  "a message whose recipients the server can fill in. For this one, create a draft with create_draft, reply_to, and the recipients, and send it with send_draft";
const sendReplyPlan = (
  send: Send,
  args: { account: string; message: string; reply_all?: boolean },
) =>
  replyPlan(send, {
    account: normalizeEmail(args.account)!,
    message: args.message,
    all: args.reply_all ?? false,
    given: null,
  }).pipe(
    Effect.mapError((failure) =>
      failure.code === "invalid_arguments" && failure.field?.name === "to"
        ? new ToolFailure({
            code: "invalid_arguments",
            field: { name: "message", expects: replyExpects },
          })
        : failure,
    ),
  );
/** Every draft attachment is listed on the page; keep that complete list readable. */
const MAX_DRAFT_FILES = 20;
const MAX_DRAFT_HEADERS = 20_000;
const fileValues = (
  files: ReadonlyArray<{ filename: string; type: string; size: number }>,
): ViewValue[] => {
  if (!files.length) return [];
  return [
    { name: "Attachments", text: filesText(files), from: "gmail" },
    ...files.map((file, i) => ({
      name: `Attachment ${i + 1}`,
      text: fileText(file),
      from: "gmail" as const,
    })),
  ];
};
const duplicateValue = (duplicate?: number): ViewValue[] =>
  duplicate === undefined
    ? []
    : [
        {
          name: "Duplicate",
          text: `${duplicate} (a deliberate copy of an earlier call)`,
          from: "agent",
        },
      ];
const forwardBody = (quoted: string, note?: string) => (note ? `${note}\n\n${quoted}` : quoted);
const draftNote =
  "This is the draft as it is in Gmail now. It is sent as it is at the moment you approve, also if it changed after this page loaded.";

export const TOOLS: ReadonlyArray<Tool> = [
  {
    kind: "plain",
    name: "list_accounts",
    label: "List accounts",
    annotations: { readOnlyHint: true },
    description:
      "Lists the Google accounts this connection can use, as a JSON array. Each entry has account (its email address), name, and services, with gmail and/or calendar and each service's status and optional message. Only services with at least one tool set to ask or allow on that account appear. An empty array means the owner has not given this connection access to any account.",
    run: (ctx) =>
      listVisibleAccounts(ctx).pipe(
        Effect.map((accounts) =>
          accounts.map((a) => ({
            account: a.email,
            name: a.name,
            services: Object.fromEntries(
              SERVICES.flatMap((service) => {
                const access = a.services[service];
                if (!access) return [];
                const status = access.status.kind;
                return [
                  [
                    service,
                    {
                      status,
                      ...(status === "ready"
                        ? {}
                        : { message: accountMessage(status, a.email, ctx.origin, service) }),
                    },
                  ],
                ];
              }),
            ),
          })),
        ),
      ),
  },
  accountTool({
    name: "list_labels",
    annotations: { readOnlyHint: true },
    group: "Find and read",
    irreversible: false,
    label: "List labels",
    permissionDescription: "See the names of this account's Gmail labels.",
    description:
      "Lists the Gmail labels of one Google account. `account` is the address of an account that list_accounts returns. When the owner sets this tool to ask, it returns a pending approval with a link instead of labels; get_approval returns the labels after the owner approves.",
    input: Schema.Struct({ account: Schema.String }),
    expects: { account: "a string" },
    view: {
      action: "list the Gmail labels",
      joiner: "of",
      values: () => Effect.succeed([]),
    },
    run: (send, account) =>
      listLabels(send).pipe(Effect.map((labels) => ({ account: account.email, labels }))),
  }),
  accountTool({
    name: "search_threads",
    annotations: { readOnlyHint: true },
    group: "Find and read",
    irreversible: false,
    label: "Search mail",
    permissionDescription:
      "Find threads with a Gmail search, and see each thread's subject, sender, date, and snippet.",
    description: `Searches the mail of one Google account and returns its threads, newest first. \`account\` is the address of an account that list_accounts returns; to search every account, call this tool once for each of them. \`query\` uses the syntax of Gmail's search box, for example \`in:inbox is:unread\` for unread inbox mail or \`from:alex subject:invoice\`. A search leaves out Spam and Trash unless the query names them, as \`in:trash\` does. \`limit\` is the largest number of threads, ${DEFAULT_LIMIT} by default and ${MAX_LIMIT} at most. When the result has \`next_page\`, send the same call with \`page\` set to that value to get more. Each thread has its ID, the subject of its first message, the sender and date of its last message, a snippet, its number of messages, and whether any message is unread. When the owner sets this tool to ask, it returns a pending approval with a link instead of threads; get_approval returns the threads after the owner approves.`,
    input: Schema.Struct({
      account: Schema.String,
      // Both go into the request's address, so each has a length limit.
      query: Schema.String.check(Schema.isBetweenLength(1, MAX_QUERY)),
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIMIT })),
      ),
      page: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, MAX_PAGE))),
    }),
    expects: {
      account: "a string",
      query: `a string of 1 to ${MAX_QUERY} characters`,
      limit: `a whole number from 1 to ${MAX_LIMIT}`,
      page: "the next_page value of an earlier result",
    },
    view: {
      action: "search the mail",
      joiner: "of",
      // The page marks every value as the agent's text, so each one is a value of the call.
      values: (args) =>
        Effect.succeed([
          { name: "Query", text: args.query, from: "agent" },
          { name: "Limit", text: String(args.limit ?? DEFAULT_LIMIT), from: "agent" },
          ...(args.page === undefined
            ? []
            : [{ name: "Page", text: args.page, from: "agent" as const }]),
        ]),
    },
    run: (send, account, args) =>
      searchThreads(send, {
        query: args.query,
        limit: args.limit ?? DEFAULT_LIMIT,
        page: args.page,
      }).pipe(Effect.map((found) => ({ account: account.email, ...found }))),
  }),
  accountTool({
    name: "read_thread",
    annotations: { readOnlyHint: true },
    label: "Read thread",
    group: "Find and read",
    irreversible: false,
    permissionDescription:
      "Read every message of a thread in full, and see the names of its attachments.",
    description: `Returns the messages of one thread of one Google account, oldest first, as plain text. \`account\` is the address of an account that list_accounts returns. \`thread\` is a thread ID that search_threads returned for that account; an ID works only in the account that returned it. \`message_count\` is the number of messages in the thread. Each message has its ID, its position in the thread, \`from\`, \`to\`, \`cc\`, its date, its label IDs, its text, and its attachments. When a message has Reply-To, \`reply_to\` is that header, unfolded and shortened to ${MAX_REPLY_HEADER} characters; a reply goes there instead of to \`from\` when it is not empty. A reply to the account's own message goes to that message's To. \`bcc\` is present when the message has that header, which is normally mail that the account wrote. A message that is a draft has \`draft\`, its draft ID. HTML mail is converted to plain text, and a link keeps its address in parentheses. An attachment has an ID, a file name, a media type, and a size in bytes; the result holds no file. \`inline: true\` marks an image that stands inside the body; converted HTML says \`[image: name]\` where it stood. A very long field is shortened: a list of recipients ends with \`… and N more\`, and \`attachments_left_out\` counts the attachments that are not listed. A result has at most ${LIMIT.toLocaleString("en-US")} characters. When it has \`next_page\`, it stops before the end of the thread: send the same call with \`page\` set to that value to get the rest. A message with \`text_cut\` does not hold its whole text: \`end\` means that the next page continues it, \`start\` that it continues the page before, and \`both\` means both. Reading changes nothing in Gmail: unread mail stays unread. When the owner sets this tool to ask, it returns a pending approval with a link instead of messages; get_approval returns the messages after the owner approves.`,
    input: Schema.Struct({
      account: Schema.String,
      thread: GmailId,
      page: Schema.optionalKey(
        Schema.String.check(
          Schema.isBetweenLength(1, 100),
          Schema.makeFilter((page) => placeOf(page) !== null),
        ),
      ),
    }),
    expects: {
      account: "a string",
      thread: "a thread ID that search_threads returned",
      page: "the next_page value of an earlier result",
    },
    view: {
      action: "read a thread",
      joiner: "in",
      values: (args, send) =>
        Effect.gen(function* () {
          const summary = yield* threadSummary(send, args.thread);
          const values: ViewValue[] = [
            { name: "Subject", text: summary.subject, from: "gmail" },
            { name: "Messages", text: String(summary.messages.length), from: "gmail" },
            { name: "Last message from", text: summary.from, from: "gmail" },
            { name: "Last message date", text: viewDate(summary.date), from: "gmail" },
          ];
          if (args.page !== undefined) {
            const place = placeOf(args.page);
            const position = place ? summary.messages.indexOf(place.message) : -1;
            if (!place || position < 0) return yield* Effect.fail(new ViewUnavailable());
            values.push({
              name: "Starts at",
              from: "agent",
              text: `Message ${position + 1} of ${summary.messages.length}${place.offset ? `, after its first ${place.offset.toLocaleString("en-US")} characters` : ""}`,
            });
          }
          return values;
        }),
    },
    run: (send, account, args) =>
      readThread(send, { account: account.email, thread: args.thread, page: args.page }),
  }),
  accountTool({
    name: "change_labels",
    label: "Change labels",
    group: "Organize",
    // A label that a call removed can be added back, and an archived thread returns to the inbox.
    irreversible: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    permissionDescription:
      "Archive threads, mark them read or unread, and add or remove labels. It cannot move mail to the trash or to spam, or take it out.",
    description: `Adds and removes labels on threads of one Google account. \`account\` is the address of an account that list_accounts returns. \`threads\` is a list of 1 to ${MAX_ITEMS} thread IDs that search_threads returned for that account. \`add\` and \`remove\` are lists of label IDs that list_labels returned for that account, at most ${MAX_LABELS} each; the call needs at least one label, and no label in both lists. The change applies to every message of each thread. To archive a thread, remove \`INBOX\`. The tool cannot add \`INBOX\`, because that would also take mail out of the trash or spam. To mark it as read, remove \`UNREAD\`; to mark it as unread, add \`UNREAD\`. To star it, add \`STARRED\`. Of the system labels, the tool accepts only \`UNREAD\`, \`STARRED\`, \`IMPORTANT\`, and the five \`CATEGORY_\` labels, and \`INBOX\` in \`remove\`: it does not move mail to the trash or to spam or take it out, and it creates no label. The result's \`threads\` has one entry for each thread that changed: its ID and \`labels\`, the IDs of the labels that at least one of its messages has after the change. \`not_found\` lists the threads that the account does not have. \`unconfirmed\` lists the threads whose change Google did not confirm: send the call again with those threads, because repeating a change is safe. Each of the two is left out when it is empty. The call fails as a whole only when no thread is confirmed changed. When it fails with a message that Google did not confirm the request, a thread may have changed, and sending the same call again is safe. When the owner sets this tool to ask, it returns a pending approval with a link instead of a result; get_approval returns the result after the owner approves.`,
    input: Schema.Struct({
      account: Schema.String,
      threads: Schema.Array(GmailId).check(Schema.isBetweenLength(1, MAX_ITEMS), Schema.isUnique()),
      add: Schema.optionalKey(
        LabelIds.check(Schema.makeFilter((ids) => !ids.some((id) => REFUSED_ADD.has(id)))),
      ),
      remove: Schema.optionalKey(LabelIds),
    }).check(
      Schema.makeFilter((args) => {
        const { add, remove } = labelChange(args);
        if (add.length + remove.length === 0)
          return { path: ["add"], issue: "At least one label is required" };
        if (remove.some((id) => add.includes(id)))
          return { path: ["remove"], issue: "A label cannot be added and removed" };
        return undefined;
      }),
    ),
    expects: {
      account: "a string",
      threads: `a list of 1 to ${MAX_ITEMS} different thread IDs that search_threads returned`,
      add: LABELS_EXPECT,
      remove: LABELS_EXPECT,
    },
    view: {
      action: "add or remove labels on threads",
      joiner: "in",
      notes: (args) => labelChangeNotes(labelChange(args)),
      values: (args, send) => labelChangeValues(send, labelChange(args)),
    },
    run: (send, account, args) =>
      changeLabels(send, {
        account: account.email,
        ...labelChange(args),
      }),
  }),
  accountTool({
    name: "create_draft",
    label: "Create draft",
    group: "Draft",
    // The owner can delete a draft, and writing one sends nothing.
    irreversible: false,
    permissionDescription: "Write a draft, new or as a reply. Nothing is sent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    description:
      "Creates a draft, new or as a reply, in one Google account. Nothing is sent. `account` is the address of an account that list_accounts returns. `to`, `cc`, and `bcc` are optional lists of mailboxes, each an address or Name <address>. A draft needs no recipients or subject. `subject` is optional for a new draft, at most 998 characters, with no control characters. `body` is required plain text and may be empty. A reply includes no quote of the answered message unless you write one in body. `reply_to` is a message ID from read_thread for this account. A reply takes its recipients from the message's Reply-To when it has one (the reply_to field of read_thread), else from its From, and its subject from the message with Re: added when needed. A reply to the account's own message goes to that message's To. `reply_all: true` also includes the other To and Cc addresses, without the account's own address or repeated addresses. When you give a non-empty to, cc, or bcc, the reply has exactly the recipients you give. Give to when you must be sure where a reply goes. `reply_all: true` requires reply_to and cannot be combined with given recipients; a non-empty subject cannot be combined with reply_to. The result has account, draft, message, and thread. draft is the ID that stays while the draft exists; message and thread are the IDs at creation and can change when it is edited. `duplicate` is an optional whole number from 2 to 100 for a deliberate copy.\n\nRepeating: a call with the same arguments as a call of the last 7 days is the same call. It never creates a second draft. It returns the first call's result with `repeat_of`, or its pending approval. So when you get no answer or an error that says to try again, call again with exactly the same arguments. Copy them; do not reword the text, because changed text is a new draft. When the answer says that the outcome is unknown, do not try another wording: ask the owner to look in Gmail. To create one more draft with the same content on purpose, add `duplicate: 2` (then 3).\n\nWith ask, a reply that cannot be built appears on the owner's page, not in the agent's answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of a draft; get_approval returns the draft after the owner approves." +
      "\n\n" +
      attachmentsDescription,
    input: DraftInput,
    also: (args) => alsoOf(args.attachments),
    uploads: (args) => uploadsOf(args.attachments),
    defaults: { to: [], cc: [], bcc: [], subject: "", reply_all: false, attachments: [] },
    unknown: (email, until, args) => {
      const next = (args.duplicate ?? 1) + 1;
      return `The server does not know whether the draft was created in ${email}. Ask the owner to look in Drafts. Until ${isoSeconds(until)}, repeating this call does not create it again.${next <= 100 ? ` If the owner says that the draft is missing, call again with duplicate: ${next}${uploadsOf(args.attachments).length ? " and a new upload of each file" : ""}.` : ""}`;
    },
    expects: draftExpects,
    view: {
      action: "create a draft",
      joiner: "in",
      values: (args, send, sources) =>
        Effect.gen(function* () {
          const boxes = draftRecipients(args);
          const plan = args.reply_to
            ? yield* replyPlan(send, {
                account: normalizeEmail(args.account)!,
                message: args.reply_to,
                all: args.reply_all ?? false,
                given: givenRecipients(boxes),
              })
            : undefined;
          const mail = draftMail(args, boxes, plan);
          return draftValues(
            args,
            mail,
            boxes,
            plan,
            yield* attachmentValues(args.attachments ?? [], sources),
          );
        }),
    },
    create: (send, account, args, confirm, sources) =>
      Effect.gen(function* () {
        const boxes = draftRecipients(args);
        const plan = args.reply_to
          ? yield* replyPlan(send, {
              account: account.email,
              message: args.reply_to,
              all: args.reply_all ?? false,
              given: givenRecipients(boxes),
            })
          : undefined;
        const stage = yield* composedDraft(
          send,
          draftMail(args, boxes, plan),
          args.attachments,
          sources,
          plan?.thread,
        );
        if (alsoOf(args.attachments).length) yield* confirm.check;
        return yield* creating(stage);
      }),
  }),
  accountTool({
    name: "trash_messages",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    label: "Move to trash",
    group: "Trash and delete",
    // restore_messages takes a message out of the trash, for the 30 days that Gmail keeps it.
    irreversible: false,
    permissionDescription:
      "Move messages to the trash. Gmail deletes a message for good after 30 days there.",
    description: `Moves messages of one Google account to the trash. \`account\` is the address of an account that list_accounts returns. \`messages\` is a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages move: the other messages of their threads stay where they are. In the trash, a message loses the label INBOX and keeps its other labels. Gmail deletes a message for good after 30 days in the trash, and restore_messages takes it out before that. In the result, \`messages\` holds each message that moved, with its label IDs after the change. \`not_found\` lists the IDs that the account does not have. \`unconfirmed\` lists the IDs for which Google did not confirm the change: call again with those IDs. Each of the two is present only when it is not empty. When no message moved, the call returns an error. Calling again with the same IDs is safe: a message that is already in the trash stays there. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.`,
    input: MessagesInput,
    expects: messagesExpects,
    view: {
      action: "move messages to the trash",
      joiner: "in",
      values: (args, send) => messageValues(send, args.messages),
    },
    run: (send, account, args) =>
      trashMessages(send, { account: account.email, messages: args.messages }),
  }),
  accountTool({
    name: "restore_messages",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    label: "Restore from trash",
    group: "Trash and delete",
    // trash_messages puts the message back in the trash.
    irreversible: false,
    permissionDescription: "Take messages out of the trash.",
    description: `Takes messages of one Google account out of the trash. \`account\` is the address of an account that list_accounts returns. \`messages\` is a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages are restored. In the result, \`messages\` holds each restored message with its label IDs after the change. A restored message is not back in the inbox: Gmail removes the label INBOX when a message goes to the trash and does not add it back, while the message keeps its other labels, such as UNREAD, STARRED, and the owner's own labels. It stays out of the trash and out of the inbox. \`not_found\` lists the IDs that the account does not have, which includes messages that were deleted for good. \`unconfirmed\` lists the IDs for which Google did not confirm the change: call again with those IDs. Each of the two is present only when it is not empty. When no message was restored, the call returns an error. Calling again with the same IDs is safe. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.`,
    input: MessagesInput,
    expects: messagesExpects,
    view: {
      action: "take messages out of the trash",
      joiner: "in",
      values: (args, send) => messageValues(send, args.messages),
    },
    run: (send, account, args) =>
      restoreMessages(send, { account: account.email, messages: args.messages }),
  }),
  accountTool({
    name: "delete_messages",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    label: "Delete permanently",
    group: "Trash and delete",
    // Gmail cannot bring a deleted message back.
    irreversible: true,
    permissionDescription: "Delete messages for good, without the trash. Nobody can recover them.",
    description: `Deletes messages of one Google account for good. Gmail cannot bring them back, and they do not go to the trash. Use trash_messages when the owner may want a message back. \`account\` is the address of an account that list_accounts returns. \`messages\` is a list of 1 to ${MAX_ITEMS} different message IDs that read_thread returned for that account; an ID works only in the account that returned it. Only the named messages are deleted: the other messages of their threads stay. In the result, \`messages\` holds the IDs that were deleted. \`not_found\` lists the IDs that the account does not have. \`unconfirmed\` lists the IDs for which Google did not confirm the delete: call again with those IDs. Each of the two is present only when it is not empty. When no message was deleted, the call returns an error. A deleted message counts as not found. So when an ID was unconfirmed, or a call failed, got no answer, or ended as unknown, and a later call reports that ID as not found, the message is gone. When the owner sets this tool to ask, it returns a pending approval with a link instead; get_approval returns the result after the owner approves.`,
    input: MessagesInput,
    expects: messagesExpects,
    view: {
      action: "delete messages permanently",
      joiner: "from",
      notes: () => [
        {
          text: "These messages cannot be recovered. They do not go to the trash: Gmail deletes them at once and for good.",
          warning: true,
        },
      ],
      values: (args, send) => messageValues(send, args.messages),
    },
    run: (send, account, args) =>
      deleteMessages(send, { account: account.email, messages: args.messages }),
  }),
  accountTool({
    name: "get_attachment",
    label: "Download attachment",
    group: "Download attachments",
    irreversible: false,
    permissionDescription:
      "Download a file attached to a message of this account, or copy it into mail that this connection writes from any account.",
    annotations: { readOnlyHint: true },
    description:
      "Returns one attachment of a message of one Google account. `account` is the address of an account that list_accounts returns. `message` is a message ID and `attachment` an attachment ID that read_thread returned for that account; both work only in that account. The result has two parts. The first is JSON with the account, the message, the attachment, and the file's name, media type, and size in bytes. The second is the file. In Claude Code the file comes as an embedded resource of any type: Claude Code saves it to disk and gives its path. In other clients an image (PNG, JPEG, GIF, or WebP) comes as an image and a text file as text, and any other file, such as a PDF, returns attachment_not_readable: tell the owner that Claude Code can open it. An attachment larger than 12 MB returns attachment_too_large with its size. Downloading changes nothing in Gmail. When the owner sets this tool to ask, it returns a pending approval with a link instead of the file; get_approval returns the file after the owner approves, for one hour.",
    input: Schema.Struct({
      account: Schema.String,
      message: GmailId,
      attachment: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^\d+(\.\d+)*$/u)),
    }),
    expects: {
      account: "a string",
      message: "a message ID that read_thread returned",
      attachment: "an attachment ID that read_thread returned",
    },
    view: {
      action: "download an attachment",
      joiner: "from",
      values: (args, send) =>
        Effect.gen(function* () {
          const found = yield* findAttachment(send, args);
          return [
            { name: "File", text: found.filename || "(no name)", from: "gmail" as const },
            { name: "Type", text: found.type, from: "gmail" as const },
            {
              name: "Size",
              text: `${found.size.toLocaleString("en-US")} bytes`,
              from: "gmail" as const,
            },
            { name: "From", text: shorten(found.from, 500), from: "gmail" as const },
            { name: "Subject", text: shorten(found.subject, 500), from: "gmail" as const },
            { name: "Date", text: viewDate(found.date), from: "gmail" as const },
          ];
        }),
    },
    run: (send, account, args, takes) =>
      Effect.gen(function* () {
        const found = yield* findAttachment(send, args);
        if (found.size > MAX_ATTACHMENT_BYTES)
          return yield* Effect.fail(tooLarge(found, MAX_ATTACHMENT_BYTES));
        if (!takes(found.type)) return yield* Effect.fail(notReadable(found));
        const bytes = yield* partBytes(send, args.message, found.part);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
          return yield* Effect.fail(
            tooLarge({ ...found, size: bytes.byteLength }, MAX_ATTACHMENT_BYTES),
          );
        return new WithFile(
          {
            account: account.email,
            message: args.message,
            attachment: args.attachment,
            filename: found.filename,
            type: found.type,
            size: found.size,
          },
          { bytes, filename: found.filename, type: found.type, charset: found.charset },
        );
      }),
  }),
  accountTool({
    name: "send_message",
    label: "Send message",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Send a new message from this account. A sent message cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Sends a new plain text message from one Google account. A sent message cannot be taken back. \`account\` is the address of an account that list_accounts returns. \`to\` is a required non-empty list of mailboxes, each an address or Name <address>; \`cc\` and \`bcc\` are optional lists. \`subject\` is required, 1 to 998 characters without control characters. \`body\` is required plain text and may be empty. \`duplicate\` is an optional whole number from 2 to 100 for a deliberate copy. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}${deliberateSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.\n\n${attachmentsDescription}`,
    input: Schema.Struct({
      account: DraftInput.fields.account,
      to: Mailboxes.check(Schema.isMinLength(1)),
      cc: DraftInput.fields.cc,
      bcc: DraftInput.fields.bcc,
      subject: Subject.check(Schema.isMinLength(1)),
      body: DraftInput.fields.body,
      duplicate: DraftInput.fields.duplicate,
      attachments: DraftInput.fields.attachments,
    }),
    expects: {
      account: draftExpects.account,
      to: "a list of at least one mailbox, each an address or Name <address>",
      cc: "a list of mailboxes, each an address or Name <address>",
      bcc: "a list of mailboxes, each an address or Name <address>",
      subject: `a string of 1 to ${MAX_SUBJECT} characters without control characters`,
      body: draftExpects.body,
      duplicate: draftExpects.duplicate,
      attachments: attachmentsExpect,
    },
    also: (args) => alsoOf(args.attachments),
    uploads: (args) => uploadsOf(args.attachments),
    defaults: { cc: [], bcc: [], attachments: [] },
    unknown: unknownSend,
    view: {
      action: "send a message",
      notes: () => [{ text: "A sent message cannot be taken back.", warning: true }],
      joiner: "from",
      values: (args, _send, sources) =>
        Effect.gen(function* () {
          const boxes = draftRecipients(args);
          return draftValues(
            args,
            draftMail(args, boxes),
            boxes,
            undefined,
            yield* attachmentValues(args.attachments ?? [], sources),
          );
        }),
    },
    create: (send, _account, args, confirm, sources) =>
      sendMail(send, confirm, draftMail(args, draftRecipients(args)), args.attachments, sources),
  }),
  accountTool({
    name: "send_reply",
    label: "Send reply",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Reply to a message in its thread: to its reply address or its sender, or to everyone on it. A sent reply cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Sends a plain text reply in a message's thread. A sent reply cannot be taken back. \`account\` is the address of an account that list_accounts returns. \`message\` is a message ID from read_thread for this account, 1 to 64 letters, digits, hyphens, or underscores. The recipients and subject come from that message, as in create_draft with reply_to and no given recipients: Reply-To (the reply_to field of read_thread) or From, or To for the account's own message, and Re: when needed. \`reply_all: true\` adds the message's other To and Cc recipients, without the account's own address or repeated addresses; it defaults to false. \`body\` is required plain text and may be empty. The body holds no quote unless you write one. \`duplicate\` is an optional whole number from 2 to 100 for a deliberate copy. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}${deliberateSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.\n\n${attachmentsDescription}`,
    input: Schema.Struct({
      account: DraftInput.fields.account,
      message: GmailId,
      body: DraftInput.fields.body,
      reply_all: DraftInput.fields.reply_all,
      duplicate: DraftInput.fields.duplicate,
      attachments: DraftInput.fields.attachments,
    }),
    expects: {
      account: draftExpects.account,
      message: "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
      body: draftExpects.body,
      reply_all: "a boolean",
      duplicate: draftExpects.duplicate,
      attachments: attachmentsExpect,
    },
    also: (args) => alsoOf(args.attachments),
    uploads: (args) => uploadsOf(args.attachments),
    defaults: { reply_all: false, attachments: [] },
    unknown: unknownSend,
    view: {
      action: "send a reply",
      notes: () => [{ text: "A sent message cannot be taken back.", warning: true }],
      joiner: "from",
      values: (args, send, sources) =>
        Effect.gen(function* () {
          const plan = yield* sendReplyPlan(send, args);
          const boxes = draftRecipients({});
          return draftValues(
            args,
            draftMail(args, boxes, plan),
            boxes,
            plan,
            yield* attachmentValues(args.attachments ?? [], sources),
          );
        }),
    },
    create: (send, _account, args, confirm, sources) =>
      sendReplyPlan(send, args).pipe(
        Effect.flatMap((plan) =>
          sendMail(
            send,
            confirm,
            draftMail(args, draftRecipients({}), plan),
            args.attachments,
            sources,
            plan.thread,
          ),
        ),
      ),
  }),
  accountTool({
    name: "forward_message",
    label: "Forward message",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Forward a message, with its text and its attachments, to the addresses the agent gives. It cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Forwards a message's original text and every attachment, including inline images, as plain text with files. A sent message cannot be taken back. \`account\` is the address of an account that list_accounts returns. \`message\` is a message ID from read_thread for this account, 1 to 64 letters, digits, hyphens, or underscores. \`to\` is a required non-empty list of mailboxes, each an address or Name <address>; \`cc\` and \`bcc\` are optional lists. \`body\` is an optional plain text note before the forwarded text, empty by default. The forward stays in the original's thread in this account and adds Fwd: to its subject when needed. The limit is ${MAX_FORWARD_BYTES.toLocaleString("en-US")} bytes of attachments and text, and ${MAX_FORWARD_FILES} attachments. The original's text must fit ${PAGE_BODY_BYTES.toLocaleString("en-US")} bytes of body, ${MAX_TEXT.toLocaleString("en-US")} characters, and ${MAX_BODY_PARTS} body parts that Gmail gives apart; if it cannot be forwarded whole, nothing is sent. Parts that are neither plain/HTML text nor attachments are omitted, such as a calendar invitation without a file name or attachment ID. It needs only forward_message's setting. \`duplicate\` is an optional whole number from 2 to 100 for a deliberate copy. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}${deliberateSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.`,
    input: Schema.Struct({
      account: DraftInput.fields.account,
      message: GmailId,
      to: Mailboxes.check(Schema.isMinLength(1)),
      cc: DraftInput.fields.cc,
      bcc: DraftInput.fields.bcc,
      body: Schema.optionalKey(DraftInput.fields.body),
      duplicate: DraftInput.fields.duplicate,
    }),
    expects: {
      account: draftExpects.account,
      message: "a message ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
      to: "a list of at least one mailbox, each an address or Name <address>",
      cc: "a list of mailboxes, each an address or Name <address>",
      bcc: "a list of mailboxes, each an address or Name <address>",
      body: draftExpects.body,
      duplicate: draftExpects.duplicate,
    },
    defaults: { cc: [], bcc: [], body: "" },
    unknown: unknownSend,
    view: {
      action: "forward a message",
      notes: () => [{ text: "A sent message cannot be taken back.", warning: true }],
      joiner: "from",
      values: (args, send) =>
        Effect.gen(function* () {
          const plan = yield* forwardPlan(send, args.message);
          if (plan.files.length > MAX_FORWARD_FILES)
            return yield* Effect.fail(new ViewUnavailable());
          const bytes =
            new TextEncoder().encode(forwardBody(plan.quoted, args.body)).byteLength +
            plan.files.reduce((n, f) => n + f.size, 0);
          if (bytes > MAX_FORWARD_BYTES)
            return yield* Effect.fail(messageTooLarge({ bytes, limit: MAX_FORWARD_BYTES }));
          const mail = draftMail({ body: "", subject: plan.subject }, draftRecipients(args));
          const recipients = draftValues({ body: "" }, mail, draftRecipients(args)).filter(
            (v) => v.name !== "Body",
          );
          return [
            { name: "Forwards a message from", text: plan.original.from, from: "gmail" as const },
            { name: "Its subject", text: plan.original.subject, from: "gmail" as const },
            { name: "Its date", text: viewDate(plan.original.date), from: "gmail" as const },
            ...recipients.map((v) => (v.name === "Subject" ? { ...v, from: "gmail" as const } : v)),
            ...fileValues(plan.files),
            ...(plan.omitted
              ? [
                  {
                    name: "Not forwarded",
                    text:
                      plan.omitted === 1
                        ? "1 part that is neither text nor a file, such as a calendar invitation"
                        : `${plan.omitted} parts that are neither text nor files, such as a calendar invitation`,
                    from: "gmail" as const,
                  },
                ]
              : []),
            ...duplicateValue(args.duplicate),
            ...(args.body ? [{ name: "Note", text: args.body, from: "agent" as const }] : []),
            { name: "Forwarded text", text: plan.quoted, from: "gmail" as const },
          ];
        }),
    },
    create: (send, _account, args, confirm) =>
      Effect.gen(function* () {
        const plan = yield* forwardPlan(send, args.message);
        const body = forwardBody(plan.quoted, args.body);
        const files = yield* forwardFiles(
          send,
          args.message,
          plan,
          new TextEncoder().encode(body).byteLength,
        );
        const message = mixedMessage(
          draftMail({ body, subject: plan.subject }, draftRecipients(args)),
          files,
        );
        return yield* sendStaged(confirm, uploadDraft(send, { message, thread: plan.thread }));
      }),
  }),
  accountTool({
    name: "send_draft",
    label: "Send draft",
    group: "Send",
    irreversible: true,
    permissionDescription:
      "Send a draft that exists in this account, as it is in Gmail at that moment. It cannot be taken back.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    description: `Sends an existing draft as it is in Gmail at that moment, including changes made there. With ask, a draft that the page cannot show whole cannot be approved: more than ${MAX_DRAFT_FILES} attachments, text that cannot be shown whole (${PAGE_BODY_BYTES.toLocaleString("en-US")} bytes of body, ${MAX_TEXT.toLocaleString("en-US")} characters, or ${MAX_BODY_PARTS} body parts that Gmail gives apart, or HTML that could not be converted), more than ${MAX_DRAFT_HEADERS.toLocaleString("en-US")} characters in its From, To, Cc, Bcc, and Subject, a repeated From, To, Cc, Bcc, Subject or Reply-To header, or a part that is neither text nor a file. A sent message cannot be taken back, and the draft is gone from Drafts afterwards. \`account\` is the address of an account that list_accounts returns. \`draft\` is a draft ID from create_draft or read_thread for this account, 1 to 64 letters, digits, hyphens, or underscores. The result has account, message, and thread, the IDs of the sent message and its thread.\n\n${repeatSend}\n\nWith ask, a send that cannot be built appears on the owner's page, not in your answer. When the owner sets this tool to ask, it returns a pending approval with a link instead of sending; get_approval returns the result after the owner approves.`,
    input: Schema.Struct({ account: DraftInput.fields.account, draft: GmailId }),
    expects: {
      account: draftExpects.account,
      draft: "a draft ID of 1 to 64 letters, digits, hyphens, or underscores from this account",
    },
    defaults: {},
    unknown: (email, until, args) =>
      `The server does not know whether draft "${args.draft}" went out from ${email}. Ask the owner to look in Sent. If the draft is still in Drafts, the owner can send it from Gmail. Until ${isoSeconds(until)}, repeating this call does not send it again.`,
    view: {
      action: "send a draft",
      joiner: "from",
      notes: () => [{ text: draftNote, warning: true }],
      asItIs: true,
      values: (args, send) =>
        Effect.gen(function* () {
          const raw = yield* readDraft(send, args.draft);
          const names = ["From", "To", "Cc", "Bcc", "Subject", "Reply-To"];
          const headers = raw.payload.headers ?? [];
          if (
            names.some(
              (name) =>
                headers.filter((field) => field.name.toLowerCase() === name.toLowerCase()).length >
                1,
            )
          )
            return yield* Effect.fail(new ViewUnavailable());
          const fields = names.map((name) => ({
            name,
            text: header(raw.payload.headers, name),
          }));
          const files = attachmentParts(raw);
          if (
            fields
              .filter((field) => field.name !== "Reply-To")
              .reduce((n, f) => n + f.text.length, 0) > MAX_DRAFT_HEADERS ||
            files.length > MAX_DRAFT_FILES ||
            otherParts(raw).length > 0
          )
            return yield* Effect.fail(new ViewUnavailable());
          const parsed = yield* Effect.try({
            try: () => readMessage(raw),
            catch: () => new ToolFailure({ code: "google_unavailable" }),
          });
          const body = yield* textOf(send, parsed, new BodyBudget());
          if (!body.whole) return yield* Effect.fail(new ViewUnavailable());
          return [
            ...fields
              .filter((f) => f.text)
              .map((f) => ({
                ...f,
                text: ["To", "Cc", "Bcc"].includes(f.name) ? addresses(f.text).join(", ") : f.text,
                from: "draft" as const,
              })),
            ...fileValues(
              files.map((part) => ({
                filename: part.filename,
                type: part.mimeType,
                size: part.body.size,
              })),
            ).map((value) => ({ ...value, from: "draft" as const })),
            { name: "Body", text: body.text, from: "draft" as const },
          ];
        }),
    },
    create: (_send, _account, args, confirm) => sendExisting(confirm, args.draft),
  }),
  accountTool({
    name: "list_calendars",
    annotations: { readOnlyHint: true },
    group: "See calendars and events",
    irreversible: false,
    label: "List calendars",
    permissionDescription:
      "See the names of this account's calendars, what it can do in each, and their time zones.",
    description: `Lists the calendars in one account's Google Calendar list. \`account\` is the address of an account that list_accounts returns. The result has account and calendars. Each calendar has calendar (its ID), name (the account's name for it, shortened to 100 characters), primary (true for the primary calendar), access (owner, writer, reader, or free_busy), and time_zone (Google's time zone, omitted when Google gives none). Hidden and deleted calendars are left out, as in the account's Google Calendar list. Calendars come primary first, then by access in the order owner, writer, reader, free_busy, then by name and ID in locale-independent order. The server reads at most eight pages of 250 calendars. The result holds at most ${MAX_CALENDARS} calendars and ${MAX_CALENDARS_CHARACTERS.toLocaleString("en-US")} characters in the serialized calendars array. When calendars are left out, omitted counts those read but left out, and note explains the cut. A left-out calendar's ID still works in other tools. When the page cap is reached, note says that the account has more calendars than the server counted. When the owner sets this tool to ask, it returns a pending approval with a link instead of calendars; get_approval returns the calendars after the owner approves.`,
    input: Schema.Struct({ account: Schema.String }),
    expects: { account: "a string" },
    view: { action: "list the calendars", joiner: "of", values: () => Effect.succeed([]) },
    run: (send, account) =>
      listCalendars(send).pipe(Effect.map((list) => ({ account: account.email, ...list }))),
  }),
  accountTool({
    name: "search_events",
    label: "Search events",
    group: "See calendars and events",
    irreversible: false,
    annotations: { readOnlyHint: true },
    permissionDescription:
      "See the events of this account's calendars in a time range: their titles, times, places, organizers, and number of guests.",
    description:
      "Lists events in a time range in one Google account, grouped by calendar and ordered by start time. `account` is an address from list_accounts. `calendars` is an optional list of 1 to 20 calendar IDs from list_calendars, each 1 to 254 characters; without it, the tool searches the primary calendar. Google's alias `primary` is not an ID from list_calendars. Unlisted calendars get not_found. Calendars where the account sees only busy times get invalid_arguments; use check_availability for those. `from` and `to` are required: a date means the start of that day, a date-time without an offset is read in the call's zone, and a date-time with Z or ±HH:MM names an instant. Years are 1900 to 2999, seconds are optional, and fractions of a second are ignored. `to` is exclusive and must be after `from`. `time_zone` is UTC or an IANA name with a slash, such as America/Bogota; without it the call uses the primary calendar's zone. Every timed result has seconds and the call zone's offset, as YYYY-MM-DDTHH:MM:SS±HH:MM. All-day start and end stay dates, and end is the day after the last day. An event is in range when it ends after from and starts before to. Repeating events appear as occurrences, with `series` naming the series; cancelled events and working locations are left out. Other special events have `type`: out_of_office, focus_time, birthday, or from_gmail. `query` is optional Google free-text search, 1 to 500 characters, over titles, descriptions, locations, and guest and organizer names and addresses. `limit` is 1 to 50 events per calendar, 25 by default; the range has no length limit. `next_page` means there is more, even next to empty `events`: repeat the same call with calendars set to that one calendar and `page` set to next_page, at most 2,000 characters. A page needs exactly one calendar. A calendar-local failure has `error: { code, message }` instead of events. Account-wide and server failures fail the call; when every calendar fails, the call returns a tool error. Each event has its ID, title, start, end, all_day, optional location and organizer, and guest_count without rooms. `my_response`, when present, is the account's own guest answer: accepted, declined, tentative, or needs_action. On the primary calendar it uses Google's self entry; elsewhere it matches the account's address. `guests_hidden` means the organizer hid the guests or Google omitted them, so guest_count counts only the visible guests. Titles and locations are cut with … to 200 JSON characters each. A result has at most 32,000 JSON characters. At its size limit, `note` explains the cut, and later calendars have `not_read: true` and no events. Call again for each calendar with next_page or not_read. When the owner sets this tool to ask, it returns a pending approval with a link instead of events; get_approval returns the result after the owner approves.",
    input: SearchEventsInput,
    expects: {
      account: "a string",
      calendars: "a list of 1 to 20 calendar IDs from list_calendars, each 1 to 254 characters",
      from: timeExpects,
      to: `${timeExpects}, after from in the call's time zone`,
      time_zone: zoneExpects,
      query: "a string of 1 to 500 characters",
      limit: "a whole number from 1 to 50",
      page: "the next_page value of an earlier result, 1 to 2,000 characters, with exactly one calendar",
    },
    view: {
      action: "search the calendar events",
      joiner: "of",
      values: (args, send) =>
        Effect.gen(function* () {
          const ctx = yield* calendarContext(send, args.time_zone);
          const range = yield* Effect.fromResult(rangeOf(args.from, args.to, ctx.zone));
          const listed: string[] = [];
          const unlisted: string[] = [];
          const busy: string[] = [];
          for (const id of args.calendars ?? [undefined]) {
            const calendar = readableCalendar(ctx, id);
            if (Result.isSuccess(calendar))
              listed.push(`${calendar.success.name} (${calendar.success.calendar})`);
            else if (calendar.failure.code === "not_found") {
              if (id === undefined) return yield* Effect.fail(calendar.failure);
              unlisted.push(id);
            } else {
              const entry = ctx.calendars.find(
                (calendar) => calendar.calendar === (id ?? ctx.primary?.calendar),
              )!;
              busy.push(`${entry.name} (${entry.calendar})`);
            }
          }
          const values: ViewValue[] = [];
          if (listed.length)
            values.push({ name: "Calendars", text: listed.join("\n"), from: "calendar" });
          if (unlisted.length)
            values.push({
              name: "Not calendars of this account",
              text: unlisted.join("\n"),
              from: "agent",
            });
          if (busy.length)
            values.push({
              name: "Only busy times visible",
              text: busy.join("\n"),
              from: "calendar",
            });
          values.push({
            name: "Range",
            text: `${viewTime(zonedIso(range.from, ctx.zone), ctx.zone, false)} to ${viewTime(zonedIso(range.to, ctx.zone), ctx.zone)}`,
            from: "agent",
          });
          if (args.query !== undefined)
            values.push({ name: "Query", text: args.query, from: "agent" });
          values.push({
            name: "Limit",
            text: String(args.limit ?? DEFAULT_EVENT_LIMIT),
            from: "agent",
          });
          if (args.page !== undefined)
            values.push({ name: "Page", text: args.page, from: "agent" });
          return values;
        }),
    },
    run: (send, account, args) => searchEvents(send, { ...args, account: account.email }),
  }),
  accountTool({
    name: "read_event",
    label: "Read event",
    group: "See calendars and events",
    irreversible: false,
    annotations: { readOnlyHint: true },
    permissionDescription: "Read one event in full: its description, guests, and their answers.",
    description:
      "Reads one event of one Google account, with its description and guests. `account` is an address from list_accounts. `calendar` is an optional calendar ID from list_calendars, 1 to 254 characters; without it the tool reads the primary calendar. Google's alias `primary` is not an ID from list_calendars. Unlisted calendars get not_found; a calendar where the account sees only busy times gets invalid_arguments, and check_availability gives those times. `event` is an event ID from search_events, 1 to 1,024 letters, digits, hyphens, or underscores; it works only in the calendar and account that returned it. An occurrence ID reads that occurrence, with `series` naming its series. A series ID reads the series and adds `recurrence`, Google's rule lines as given. A missing or cancelled event gets not_found. `time_zone` is UTC or an IANA name with a slash, such as America/Bogota; without it the call uses the primary calendar's zone. All times use that zone, have seconds, and have the format YYYY-MM-DDTHH:MM:SS±HH:MM. All-day start and end are dates, and end is the day after the last day. The result has account, calendar, time_zone, event, title, start, end, all_day, optional location and organizer, description, guests, status (confirmed or tentative), and link to Google Calendar. Description is plain text, with HTML converted when present. Each guest has email, optional name, response (accepted, declined, tentative, or needs_action), and optional as a boolean; rooms are left out. `my_response` is the account's own guest answer when an entry exists: Google's self entry in the primary calendar, or an address match elsewhere. `guests_hidden` means the organizer hid the list or Google omitted guests; guests then holds only what Google gave. `meet` is the Google Meet link when present. Non-regular events have `type`: out_of_office, focus_time, birthday, from_gmail, or working_location. Title and location are cut with … to 1,000 JSON characters each. Description is at most 10,000 JSON characters and a cut ends with [The rest of the description was left out.]. Guests are at most 8,000 JSON characters, with guests_left_out counting the rest; recurrence is at most 4,000 JSON characters, keeping whole lines, with recurrence_left_out counting the rest. The result stays within 32,000 JSON characters. When the owner sets this tool to ask, it returns a pending approval with a link instead of the event; get_approval returns the result after the owner approves.",
    input: Schema.Struct({
      account: Schema.String,
      calendar: Schema.optionalKey(CalendarId),
      event: EventId,
      time_zone: Schema.optionalKey(ZoneName),
    }),
    expects: {
      account: "a string",
      calendar: "a calendar ID from list_calendars, 1 to 254 characters",
      event: "an event ID of 1 to 1,024 letters, digits, hyphens, or underscores",
      time_zone: zoneExpects,
    },
    view: {
      action: "read a calendar event",
      joiner: "in",
      values: (args, send) =>
        Effect.gen(function* () {
          const ctx = yield* calendarContext(send, args.time_zone);
          const calendar = yield* Effect.fromResult(readableCalendar(ctx, args.calendar));
          const event = yield* eventView(send, calendar, args.event, ctx.zone);
          return [
            {
              name: "Calendar",
              text: `${calendar.name} (${calendar.calendar})`,
              from: "calendar" as const,
            },
            { name: "Event", text: event.title, from: "calendar" as const },
            {
              name: "Starts",
              text: `${viewTime(event.start, ctx.zone)}${event.own_zone && event.own_zone !== ctx.zone ? `; event's own zone: ${event.own_zone}` : ""}`,
              from: "calendar" as const,
            },
          ];
        }),
    },
    run: (send, account, args) => readEvent(send, { ...args, account: account.email }),
  }),
  {
    kind: "plain",
    name: "get_approval",
    label: "Get approval result",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { approval: { type: "string" } },
      required: ["approval"],
    },
    description:
      "Returns the state of a call that waits for the owner's approval, and the call's result once the owner approved it. `approval` is the approval ID from the pending answer. Call it after the owner tells you that they decided. It answers at once and never waits for the owner. When the approved call returns a file, the answer has a second part with the file, in the form that get_attachment describes. The status running can also mean that the owner approved and the file is not ready yet. A client that cannot read the file gets attachment_not_readable, and the file stays for the rest of its hour.",
    run: (ctx, args) => getApproval(ctx, args),
  },
  {
    kind: "plain",
    name: "create_upload_link",
    label: "Create upload link",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    description:
      "Gives a link that takes one local file, so that create_draft, send_message, or send_reply can attach it to mail. It needs a client that can read the owner's local files and send an HTTP request, such as Claude Code. It takes no input and returns `url` and `expires_at`. Send the file with one PUT request to `url` followed by the file's name, with the file's bytes as the body and its media type in the Content-Type header. With curl: `curl -sS -T <path> -H 'Content-Type: <media type>' '<url>'`. `url` ends with a slash, so curl adds the file's name itself. The answer to that request is JSON with `upload`, the ID of the stored file, and the name, type, and size that the server stored; check them against the file. Only that answer gives the ID. Then name the file as `{ \"upload\": \"<upload>\" }` in `attachments`. A link takes one file of at most 25 MB, once. The link, and a file that no call has used, end at `expires_at`. One upload attaches to one message; for another message, ask for another link. Never put a file's content into a tool argument. If the answer is a sign-in page and not JSON, the owner has not opened `/uploads/*` in Cloudflare Access yet; tell the owner. It returns tool_not_allowed when the owner has not allowed any tool that attaches files.",
    run: (ctx) =>
      Effect.gen(function* () {
        const listed = yield* readListedTools(
          ctx.db,
          ctx.owner,
          ctx.connection.connectionId,
          ctx.now(),
        );
        if (!listed.tools.some((name) => attachingTools().includes(name as AccountTool)))
          return yield* Effect.fail(
            new ToolFailure({
              code: "tool_not_allowed",
              said: `The owner has not allowed create_draft, send_message, or send_reply on any account for this connection, so it cannot attach a file. The owner can change this at ${ctx.origin}/connections/${ctx.connection.connectionId}.`,
            }),
          );
        const created = yield* createLink(ctx);
        if (!created) return yield* Effect.fail(new ToolFailure({ code: "server_unavailable" }));
        return {
          url: `${ctx.origin}${UPLOAD_PATH}${created.link}/`,
          expires_at: isoSeconds(created.expiresAt),
        };
      }),
  },
];
export const parseAccountTool = (raw: unknown): AccountTool | null => {
  const tool = TOOLS.find((t) => t.kind === "account" && t.name === raw);
  return tool?.kind === "account" ? tool.name : null;
};
/** A tool belongs to its group's service. Unknown stored tool names grant no service. */
export const serviceOf = (name: string): Service | null => {
  const tool = TOOLS.find((tool) => tool.kind === "account" && tool.name === name);
  return tool?.kind === "account" ? GROUP_SERVICE[tool.group] : null;
};

export type ListedTools = {
  readonly active: boolean;
  readonly tools: ReadonlyArray<Tool>;
};
export const listedTools = (ctx: CallContext): Effect.Effect<ListedTools, Unavailable> =>
  readListedTools(ctx.db, ctx.owner, ctx.connection.connectionId, ctx.now()).pipe(
    Effect.map(({ active, tools }) => ({
      active,
      tools: TOOLS.filter((tool) => tool.kind === "plain" || tools.includes(tool.name)),
    })),
  );
