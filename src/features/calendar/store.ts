import { useEffect } from "react";
import { createStore } from "../../lib/store";
import {
  fetchCalendar,
  openMeetingLink,
  googleAuthStatus,
  gcalListCalendars,
  gcalListEvents,
  gcalCreateEvent,
  type CalendarData,
  type CalendarEvent,
  type CalendarInfo,
  type GCalendarMeta,
  type GCalendarEvent,
} from "../../platform/services";
import { settings } from "../../settings/store";
import { dueEvent, nextChange, nextEvent } from "./model";

/** Rust caches for ten minutes; the poll asks a little more often so a change shows within a quarter hour. */
const POLL_MS = 12 * 60_000;

/** The agenda shared by the tool, the notice and the closed-row part. `error` is a code when the whole call failed. */
export const calendar = createStore<{ data: CalendarData | null; error: string | null; loading: boolean }>({
  data: null,
  error: null,
  loading: false,
});

/** Google Calendar connected status */
export const googleCalConnected = createStore<boolean>(false);

/** The event announced in the closed notch, set by the scheduler; null while none is due or the notice or tool is off. */
export const calendarDue = createStore<CalendarEvent | null>(null);
/** The next event within the part's horizon (only while the part is on). */
export const calendarNext = createStore<CalendarEvent | null>(null);

/** Closed notices survive a restart (stored ids are pruned to the agenda's events on each close). */
const dismissedIds = createStore<string[]>([], { persist: "calendar-dismissed" });
const dismissed = new Set(dismissedIds.get());
let latest = 0;

const toolOn = () => settings.get().tools.some((t) => t.id === "calendar" && t.enabled);

function gcalToEvent(e: GCalendarEvent): CalendarEvent {
  const start = e.start?.dateTime
    ? new Date(e.start.dateTime).getTime()
    : e.start?.date
      ? new Date(e.start.date).getTime()
      : Date.now();
  const end = e.end?.dateTime
    ? new Date(e.end.dateTime).getTime()
    : e.end?.date
      ? new Date(e.end.date).getTime()
      : start + 3600_000;
  const allDay = !e.start?.dateTime && !!e.start?.date;
  return {
    id: e.id,
    calendar: e.calendarId || "primary",
    title: e.summary || "",
    location: e.location || "",
    url: e.hangoutLink || e.htmlLink || "",
    description: [e.description, e.hangoutLink].filter(Boolean).join("\n"),
    start,
    end,
    allDay,
  };
}

export async function refreshCalendar(force = false): Promise<void> {
  const call = ++latest;
  const sources = settings.get().calendar.sources.map(({ id, kind, url, user, name, color }) => ({
    id,
    kind,
    url,
    user,
    name,
    color,
  }));

  calendar.set((c) => ({ ...c, loading: true }));

  try {
    let baseData: CalendarData = {
      calendars: [],
      events: [],
      sources: [],
      fetchedAt: Date.now(),
    };

    if (sources.length > 0) {
      try {
        baseData = await fetchCalendar(sources, force);
      } catch (e) {
        console.warn("fetchCalendar error:", e);
      }
    }

    // Check Google Auth & sync Google Calendar
    const status = await googleAuthStatus().catch(() => ({ connected: false, email: null, expires_at: null }));
    googleCalConnected.set(status.connected);

    if (status.connected) {
      try {
        const [gCals, gEvents] = await Promise.all([
          gcalListCalendars().catch(() => [] as GCalendarMeta[]),
          gcalListEvents().catch(() => [] as GCalendarEvent[]),
        ]);

        const extraCalendars: CalendarInfo[] = gCals.map((gc) => ({
          id: gc.id,
          source: "google",
          name: gc.summary,
          color: gc.backgroundColor || "#0284c7",
        }));

        const extraEvents: CalendarEvent[] = gEvents.map(gcalToEvent);

        // Deduplicate calendars
        const calMap = new Map<string, CalendarInfo>();
        for (const c of [...baseData.calendars, ...extraCalendars]) {
          calMap.set(c.id, c);
        }

        // Deduplicate events by id
        const evMap = new Map<string, CalendarEvent>();
        for (const e of [...baseData.events, ...extraEvents]) {
          evMap.set(e.id, e);
        }

        baseData = {
          calendars: Array.from(calMap.values()),
          events: Array.from(evMap.values()),
          sources: [
            ...baseData.sources,
            { id: "google", error: null, fetchedAt: Date.now() },
          ],
          fetchedAt: Date.now(),
        };
      } catch (err) {
        console.warn("Google Calendar fetch error:", err);
      }
    }

    if (call === latest) {
      calendar.set({ data: baseData, error: null, loading: false });
    }
  } catch (e) {
    if (call === latest) {
      calendar.set((c) => ({ ...c, error: String(e), loading: false }));
    }
  }
}

/** Quick event creation in Google Calendar */
export async function quickCreateEvent(
  summary: string,
  start: Date | string,
  end: Date | string,
  description?: string,
  location?: string,
  calendarId?: string,
): Promise<CalendarEvent> {
  const startIso = typeof start === "string" ? start : start.toISOString();
  const endIso = typeof end === "string" ? end : end.toISOString();
  const gEvent = await gcalCreateEvent(calendarId, summary, startIso, endIso, description, location);
  const created = gcalToEvent(gEvent);

  // Optimistic insert
  calendar.set((c) => {
    if (!c.data) return c;
    return {
      ...c,
      data: {
        ...c.data,
        events: [created, ...c.data.events],
      },
    };
  });

  return created;
}

/** Hides the notice for this event. */
export function dismissCalendarNotice(id: string) {
  dismissed.add(id);
  const known = new Set((calendar.get().data?.events ?? []).map((e) => e.id));
  dismissedIds.set([...dismissed].filter((i) => i === id || known.has(i)));
  schedule();
}

/** Opens the event's meeting link (from meetingLink) and hides its notice once it opened: it has done its job. */
export function joinMeeting(id: string, link: string) {
  // On failure the notice stays, so the button can be pressed again.
  openMeetingLink(link).then(
    () => dismissCalendarNotice(id),
    () => {},
  );
}

// One timeout to the next moment the notice or the part changes (at most a minute, for standby and clock changes).
let timeout: number | undefined;
function schedule() {
  window.clearTimeout(timeout);
  const now = Date.now();
  const s = settings.get();
  const on = toolOn();
  const events = on ? (calendar.get().data?.events ?? []) : [];
  const { notice, noticeMin, horizonMin } = s.calendar;
  const due = notice ? dueEvent(events, now, noticeMin, dismissed) : null;
  if (due?.id !== calendarDue.get()?.id) calendarDue.set(due);
  const next = s.closed.parts.calendar ? nextEvent(events, now) : null;
  const shown = next && next.start - now <= horizonMin * 60_000 ? next : null;
  if (shown !== calendarNext.get()) calendarNext.set(shown);
  const at = nextChange(events, now, [noticeMin * 60_000, horizonMin * 60_000]);
  if (at !== null) timeout = window.setTimeout(schedule, Math.min(60_000, at - now) + 20);
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastSources = "";
function apply() {
  const s = settings.get();
  const key = JSON.stringify(s.calendar.sources);
  const wanted = toolOn() && (s.calendar.sources.length > 0 || googleCalConnected.get());
  if (key !== lastSources) {
    // Added, edited or removed: fetch at once (an empty list also clears Rust's cache file).
    lastSources = key;
    if (wanted || !s.calendar.sources.length) void refreshCalendar();
  }
  if (!wanted) {
    if (timer) clearInterval(timer);
    timer = null;
  } else if (!timer) {
    const { data, loading } = calendar.get();
    if (!loading && (!data || Date.now() - data.fetchedAt >= POLL_MS)) void refreshCalendar();
    timer = setInterval(() => void refreshCalendar(), POLL_MS);
  }
  schedule();
}

export function startCalendar() {
  apply();
  settings.subscribe(apply);
  calendar.subscribe(schedule);
  void refreshCalendar();
}

/** For the tool: refreshes on open when the data is older than five minutes. */
export function useCalendarViewer() {
  useEffect(() => {
    const { data, loading } = calendar.get();
    if (!loading && (!data || Date.now() - data.fetchedAt > 5 * 60_000)) {
      void refreshCalendar();
    }
  }, []);
}
