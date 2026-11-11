import { VideoCamera } from "@phosphor-icons/react";
import { calendar, calendarNext, joinMeeting } from "../../../features/calendar/store";
import { meetingLink } from "../../../features/calendar/model";
import { formatTime } from "../../../lib/format";
import type { CalendarEvent } from "../../../platform/services";
import { measureText } from "../measure";
import { t } from "../../../i18n";

const DOT = 6, GAP = 6, MAX = 170, BUTTON_SIZE = 16;

/** The next event within the horizon from the settings, null otherwise (the calendar store keeps it current). */
export function useNextEvent(): { event: CalendarEvent; color: string; text: string; link: string | null } | null {
  const event = calendarNext.use();
  const { data } = calendar.use();
  if (!event) return null;
  const color = data?.calendars.find((c) => c.id === event.calendar)?.color || "var(--color-link)";
  const now = Date.now();
  const diffMin = Math.round((event.start - now) / 60_000);
  const title = event.title || t("(Ohne Titel)");

  // Intelligent countdown display: e.g. "Control Básico en 15 min" or "Standup ahora"
  let text: string;
  if (diffMin > 0 && diffMin <= 60) {
    text = `${title} en ${diffMin} min`;
  } else if (diffMin <= 0 && event.end > now) {
    text = `${title} (en curso)`;
  } else {
    text = `${formatTime(event.start)} ${title}`;
  }

  const link = meetingLink(event);
  return { event, color, text, link };
}

/** Room for the dot, the text, and optional Meet button. */
export const nextEventWidth = (text: string, hasLink = false) =>
  DOT + GAP + Math.min(MAX, measureText(text)) + (hasLink ? GAP + BUTTON_SIZE : 0);

/** "Control Básico en 15 min" behind a dot, with optional 1-click Google Meet/Zoom button. */
export function NextEventPart({
  text,
  color,
  link,
  eventId,
}: {
  text: string;
  color: string;
  link?: string | null;
  eventId?: string;
}) {
  return (
    <span
      className="flex items-center whitespace-nowrap text-footnote font-medium text-label"
      style={{ gap: GAP }}
      title={t("Nächster Termin")}
    >
      <span className="shrink-0 rounded-full" style={{ width: DOT, height: DOT, background: color }} />
      <span className="truncate" style={{ maxWidth: MAX }}>
        {text}
      </span>
      {link && eventId && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            joinMeeting(eventId, link);
          }}
          className="pressable flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
          title={`${t("Beitreten")} · Google Meet / Zoom`}
        >
          <VideoCamera size={10} weight="fill" />
        </button>
      )}
    </span>
  );
}
