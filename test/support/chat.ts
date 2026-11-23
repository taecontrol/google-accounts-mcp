import { http } from "msw";
import { network } from "./network";
import { fixture, PERSONAL, toolCall } from "./permissions";
import { setTool } from "./uploads";

export const CHAT_SCOPES = [
  "chat.spaces.readonly",
  "chat.messages.readonly",
  "chat.messages.create",
  "chat.users.readstate.readonly",
  "chat.memberships.readonly",
  "chat.spaces.create",
].map((scope) => `https://www.googleapis.com/auth/${scope}`);
const SPACES = "https://chat.googleapis.com/v1/spaces";

export type ChatAnswer = Response | (() => Response | Promise<Response>);
export function chatFake(pages: ChatAnswer[], members: Record<string, ChatAnswer> = {}) {
  const log = { spaces: [] as URL[], members: [] as string[], peak: 0 };
  let open = 0;
  network.use(
    http.get(SPACES, ({ request }) => {
      log.spaces.push(new URL(request.url));
      const page = pages.shift();
      if (!page) throw new Error("Unexpected Chat spaces page");
      return typeof page === "function" ? page() : page;
    }),
    http.get(`${SPACES}/:space/members`, async ({ params }) => {
      const space = `spaces/${String(params.space)}`;
      log.members.push(space);
      log.peak = Math.max(log.peak, ++open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open--;
      const answer = members[space];
      if (!answer) throw new Error(`Unexpected Chat members request for ${space}`);
      return typeof answer === "function" ? answer() : answer.clone();
    }),
  );
  return log;
}

export const human = (email: string, displayName?: string) => ({
  member: { type: "HUMAN", email, ...(displayName ? { displayName } : {}) },
});
export const membersOf = (...memberships: unknown[]) =>
  Response.json({ memberships: [human(PERSONAL, "Alex"), ...memberships] });
export const directMessage = (id: string, lastActiveTime: string) => ({
  name: `spaces/${id}`,
  spaceType: "DIRECT_MESSAGE",
  lastActiveTime,
});

export const chatFixture = async () => {
  const f = await fixture({ scopes: JSON.stringify(CHAT_SCOPES) });
  await setTool(f, "list_conversations", "allow");
  return f;
};
export const listConversations = (f: Awaited<ReturnType<typeof fixture>>) =>
  toolCall(f.mcp, "list_conversations", { account: PERSONAL });
