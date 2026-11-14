import { http } from "msw";
import { network } from "./network";

// Google's documented calendarList and OAuth contracts, independent of production constants.
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
];
export const CALENDAR_LIST = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
export function calendarFake(...answers: Array<Response | ((request: Request) => Response)>) {
  const requests: Request[] = [];
  network.use(
    http.get(CALENDAR_LIST, ({ request }) => {
      requests.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error("Unexpected calendar page");
      return typeof answer === "function" ? answer(request) : answer;
    }),
  );
  return requests;
}
