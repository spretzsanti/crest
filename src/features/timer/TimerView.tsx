import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlarmIcon,
  ArrowCounterClockwise,
  Check,
  CheckCircle,
  ListChecks,
  Pause,
  PencilSimple,
  PictureInPicture,
  Play,
  SpeakerSimpleHigh,
  SpeakerSimpleSlash,
  X,
} from "@phosphor-icons/react";
import { content, pulse, springs } from "../../design/motion";
import {
  MAX_MINUTES,
  MIN_MINUTES,
  focusMuted,
  formatClock,
  presets,
  ringing,
  timer,
  timerActions,
  useRemaining,
  type TimerMode,
} from "./store";
import { Look } from "./Look";
import { modeTint } from "./looks";
import { detached, toggleDetached } from "./detach";
import { settings } from "../../settings/store";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { isNative } from "../../platform/native";
import { todos } from "../todos/store";
import { t } from "../../i18n";

const modeLabel: Record<TimerMode, string> = { focus: "Fokus", break: "Pause" };

export function TimerView() {
  const s = timer.use();
  return (
    <>
      <TimerHeader />
      {s.finished ? <FinishedView /> : <SetupView />}
    </>
  );
}

/** Mutes the focus sound for now, and pops the timer into its own small always-on-top window, or takes it back. */
function TimerHeader() {
  const open = detached.use();
  const sound = settings.use().timer.focusSound;
  const muted = focusMuted.use();
  if (!isNative && sound === "off") return null;
  return (
    <HeaderActions>
      {sound !== "off" && (
        <HeaderButton label={muted ? t("Fokus-Klang einschalten") : t("Fokus-Klang stummschalten")} onClick={() => focusMuted.set(!muted)}>
          {muted ? <SpeakerSimpleSlash size={14} weight="bold" /> : <SpeakerSimpleHigh size={14} weight="bold" />}
        </HeaderButton>
      )}
      {isNative && (
        <HeaderButton label={open ? t("Timer-Fenster schließen") : t("Timer abdocken")} active={open} onClick={toggleDetached}>
          <PictureInPicture size={14} weight="bold" />
        </HeaderButton>
      )}
    </HeaderActions>
  );
}

function FinishedView() {
  const s = timer.use();
  const ring = ringing.use();
  const { look, color } = settings.use().timer;
  const tint = modeTint(s.mode, color);
  return (
    <motion.div
      className="flex h-full flex-col justify-between px-5 pt-1 pb-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: content.enter }}
    >
      <div className="flex h-7 items-center justify-between">
        <div className="flex items-center gap-2 text-footnote font-semibold" style={{ color: tint }}>
          {ring ? (
            <motion.span className="flex" animate={{ opacity: [1, 0.35] }} transition={pulse}>
              <AlarmIcon size={15} weight="fill" />
            </motion.span>
          ) : (
            <CheckCircle size={15} weight="fill" />
          )}
          {t(s.mode === "focus" ? "Fokus abgelaufen" : "Pause abgelaufen")}
          <span className="font-medium text-label-3">· {formatClock(s.duration)}</span>
        </div>

        {/* Academic Pomodoro 1-click completion */}
        {s.linkedTask && (
          <button
            onClick={() => timerActions.completeLinkedTask()}
            className="pressable flex items-center gap-1.5 rounded-[8px] bg-emerald-500/20 px-2.5 py-1 text-caption font-semibold text-emerald-400 hover:bg-emerald-500/30"
            title={t("In Google Tasks abschließen")}
          >
            <Check size={13} weight="bold" />
            <span className="truncate max-w-[140px]">{s.linkedTask.title}</span>
            <span className="text-[10px] opacity-75">✓</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">
        <motion.div
          className="flex min-w-0 flex-1"
          animate={{ opacity: ring ? [1, 0.45] : 1 }}
          transition={ring ? pulse : content.enter}
        >
          <Look look={look} remaining={0} duration={s.duration} running={false} mode={s.mode} tint={tint} h={44} />
        </motion.div>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={ring ? "silence" : "close"}
            initial={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
            exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
            transition={content.exit}
          >
            {ring ? (
              <RoundButton label={t("Alarm stoppen")} onClick={timerActions.silence} tint={tint}>
                <SpeakerSimpleSlash size={17} weight="fill" />
              </RoundButton>
            ) : (
              <RoundButton label={t("Schließen")} onClick={timerActions.dismiss}>
                <X size={16} weight="bold" />
              </RoundButton>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function SetupView() {
  const s = timer.use();
  const look = settings.use().timer.look;
  const remaining = useRemaining(look === "hud");
  const running = s.endsAt !== null;
  const tint = modeTint(s.mode, settings.use().timer.color);
  const [editing, setEditing] = useState(false);
  const clockRef = useRef<HTMLDivElement>(null);

  const editable = !running && remaining === s.duration;
  useEffect(() => {
    const el = clockRef.current;
    if (!el || !editable) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const step = (e.shiftKey ? 5 : 1) * (e.deltaY < 0 ? 1 : -1);
      timerActions.setMinutes(Math.round(timer.get().duration / 60) + step);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [editable]);

  const custom = s.custom?.[s.mode];
  const chips = custom && !presets[s.mode].includes(custom) ? [...presets[s.mode], custom] : presets[s.mode];

  return (
    <div className="flex h-full flex-col justify-between px-5 pt-1 pb-2">
      <div className="flex h-7 items-center justify-between">
        <div className="flex items-center gap-2">
          <Segmented
            disabled={running}
            value={s.mode}
            onChange={(m) => {
              setEditing(false);
              timerActions.select(m, s.custom?.[m] ?? presets[m][m === "focus" ? 1 : 0]);
            }}
          />
          {/* Academic Pomodoro Task Picker */}
          {s.mode === "focus" && (
            <TaskPicker linkedTask={s.linkedTask} running={running} onSelect={timerActions.setLinkedTask} />
          )}
        </div>

        {/* Chips and minutes field */}
        <div className="relative flex h-6 flex-1 justify-end">
          <AnimatePresence initial={false}>
            {editing ? (
              <MinutesInput
                key="input"
                initial={Math.round(s.duration / 60)}
                tint={tint}
                onDone={(minutes) => {
                  if (minutes !== null) timerActions.setMinutes(minutes);
                  setEditing(false);
                }}
              />
            ) : (
              <motion.div
                key="chips"
                className="absolute top-0 end-0 flex gap-1"
                initial={{ opacity: 0, filter: "blur(4px)" }}
                animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
                exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
              >
                {chips.map((d) => (
                  <button
                    key={d}
                    onClick={() => timerActions.select(s.mode, d)}
                    disabled={running}
                    aria-label={t("{n} Min.", { n: d / 60 })}
                    aria-pressed={d === s.duration}
                    className={`pressable pressable-fill tabular h-6 min-w-7 rounded-full px-2.5 text-caption font-medium disabled:opacity-40 ${
                      d === s.duration ? "bg-fill-2 text-label" : "text-label-3"
                    }`}
                  >
                    {d / 60}
                  </button>
                ))}
                <button
                  aria-label={t("Eigene Zeit")}
                  title={t("Eigene Zeit (oder Mausrad über der Zeit)")}
                  onClick={() => setEditing(true)}
                  className="pressable pressable-fill flex size-6 items-center justify-center rounded-full text-label-3 hover:text-label-2"
                >
                  <PencilSimple size={12} weight="bold" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div ref={clockRef} title={editable ? t("Mausrad: ±1 min, Shift: ±5 min") : undefined} className="flex min-w-0 flex-1">
          <Look look={look} remaining={remaining} duration={s.duration} running={running} mode={s.mode} tint={tint} h={44} />
        </div>
        <div className="flex gap-1.5">
          <RoundButton label={t("Zurücksetzen")} onClick={timerActions.reset} disabled={editable}>
            <ArrowCounterClockwise size={16} weight="bold" />
          </RoundButton>
          <RoundButton
            label={running ? t("Pause") : t("Start")}
            onClick={running ? timerActions.pause : timerActions.start}
            tint={tint}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={running ? "pause" : "play"}
                className="flex"
                initial={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
                animate={{ opacity: 1, transform: "scale(1)", filter: "blur(0px)" }}
                exit={{ opacity: 0, transform: "scale(0.6)", filter: "blur(3px)" }}
                transition={content.exit}
              >
                {running ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
              </motion.span>
            </AnimatePresence>
          </RoundButton>
        </div>
      </div>
    </div>
  );
}

function TaskPicker({
  linkedTask,
  running,
  onSelect,
}: {
  linkedTask?: { id: string; projectId: string; title: string } | null;
  running: boolean;
  onSelect: (task: { id: string; projectId: string; title: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { tasks } = todos.use();
  const openTasks = tasks.filter((t) => !t.done);

  if (linkedTask) {
    return (
      <div className="flex items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-0.5 text-caption font-medium text-accent">
        <span className="truncate max-w-[130px]" title={linkedTask.title}>
          {linkedTask.title}
        </span>
        {!running && (
          <button
            onClick={() => onSelect(null)}
            className="pressable rounded-full hover:bg-accent/20 p-0.5"
            title={t("Entfernen")}
          >
            <X size={10} weight="bold" />
          </button>
        )}
      </div>
    );
  }

  if (running) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="pressable flex items-center gap-1 rounded-full bg-fill-1 px-2 py-0.5 text-caption font-medium text-label-3 hover:text-label hover:bg-fill-2"
        title={t("Aufgabe aus Google Tasks für diesen Pomodoro wählen")}
      >
        <ListChecks size={12} weight="bold" />
        <span>{t("Aufgabe verknüpfen")}</span>
      </button>

      {open && (
        <div className="absolute top-8 start-0 z-30 min-w-[200px] max-w-[260px] rounded-[10px] bg-canvas-elevated p-1 shadow-lg ring-1 ring-border">
          <div className="px-2 py-1 text-[11px] font-semibold text-label-3 uppercase tracking-wider">
            Google Tasks
          </div>
          {openTasks.length === 0 ? (
            <div className="px-2 py-1.5 text-caption text-label-4">{t("Keine offenen Aufgaben")}</div>
          ) : (
            <div className="max-h-40 overflow-y-auto [scrollbar-width:none]">
              {openTasks.slice(0, 10).map((task) => (
                <button
                  key={task.id}
                  onClick={() => {
                    onSelect({ id: task.id, projectId: task.projectId, title: task.text });
                    setOpen(false);
                  }}
                  className="pressable flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1 text-start text-caption text-label hover:bg-fill-2"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0" />
                  <span className="truncate">{task.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MinutesInput(props: { initial: number; tint: string; onDone: (minutes: number | null) => void }) {
  const [value, setValue] = useState(String(props.initial));
  const ref = useRef<HTMLInputElement>(null);
  const minutes = Number(value);
  const valid = Number.isFinite(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  return (
    <motion.form
      className="absolute top-0 end-0 flex items-center gap-1.5"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) props.onDone(minutes);
      }}
    >
      <div className="flex h-6 items-center gap-1 rounded-full bg-fill-2 pe-2.5 ps-2.5">
        <input
          ref={ref}
          value={value}
          inputMode="numeric"
          maxLength={3}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              props.onDone(null);
            }
          }}
          onBlur={(e) => {
            if (!e.currentTarget.form?.contains(e.relatedTarget as Node)) props.onDone(null);
          }}
          className="tabular w-7 bg-transparent text-end text-caption font-semibold text-label outline-none"
        />
        <span className="text-caption text-label-3">{t("min")}</span>
      </div>
      <button
        type="submit"
        aria-label={t("Übernehmen")}
        disabled={!valid}
        className="pressable flex size-6 items-center justify-center rounded-full disabled:opacity-30"
        style={{ color: props.tint, backgroundColor: `color-mix(in srgb, ${props.tint} 18%, transparent)` }}
      >
        <Check size={12} weight="bold" />
      </button>
    </motion.form>
  );
}

function Segmented({ value, onChange, disabled }: { value: TimerMode; onChange: (m: TimerMode) => void; disabled?: boolean }) {
  return (
    <div className="flex rounded-full bg-fill-1 p-0.5">
      {(Object.keys(modeLabel) as TimerMode[]).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          disabled={disabled}
          className={`relative h-6 rounded-full px-3 text-caption font-medium transition-colors duration-150 disabled:opacity-40 ${
            m === value ? "text-label" : "text-label-3 hover:text-label-2"
          }`}
        >
          {m === value && (
            <motion.span layoutId="timer-mode" className="absolute inset-0 rounded-full bg-fill-3" transition={springs.snappy} />
          )}
          <span className="relative">{t(modeLabel[m])}</span>
        </button>
      ))}
    </div>
  );
}

function RoundButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tint?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className="pressable pressable-fill flex size-10 items-center justify-center rounded-full bg-fill-1 text-label disabled:opacity-30"
      style={props.tint ? { color: props.tint, backgroundColor: `color-mix(in srgb, ${props.tint} 18%, transparent)` } : undefined}
    >
      {props.children}
    </button>
  );
}
