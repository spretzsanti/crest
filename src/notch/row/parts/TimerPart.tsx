import { Timer } from "@phosphor-icons/react";
import { formatClock, remainingOf, timer, useSecondTick } from "../../../features/timer/store";
import { measureText } from "../measure";
import { modeTint } from "../../../features/timer/looks";
import { settings } from "../../../settings/store";

const ICON = 17, GAP = 4, TASK_MAX = 120;

/** Room for countdown and optional Academic Pomodoro task title. */
export const timerWidth = (duration: number, taskTitle?: string | null) => {
  const clockW = measureText(formatClock(duration).replace(/\d/g, "8"));
  const taskW = taskTitle ? Math.min(TASK_MAX, measureText(`${taskTitle} · `)) : 0;
  return ICON + GAP + taskW + clockW;
};

/** A running timer: icon, task title (if linked to Google Tasks) and countdown. */
export function TimerPart({ paused }: { paused: boolean }) {
  const s = timer.use();
  const color = settings.use().timer.color;
  // Ticks when the countdown's own second changes, not the wall clock's; not at all under a notice.
  const now = useSecondTick(s.endsAt !== null && !paused, (s.endsAt ?? 0) % 1000);
  const taskTitle = s.linkedTask?.title;

  return (
    <span className="flex shrink-0 items-center" style={{ gap: GAP, color: modeTint(s.mode, color) }}>
      <Timer size={ICON} weight="bold" className="shrink-0" />
      {taskTitle && (
        <span className="truncate text-footnote font-medium text-label" style={{ maxWidth: TASK_MAX }}>
          {taskTitle} ·
        </span>
      )}
      <span className="tabular whitespace-nowrap text-footnote font-medium">
        {formatClock(remainingOf(s, now))}
      </span>
    </span>
  );
}
