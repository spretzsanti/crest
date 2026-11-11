import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlarmIcon, ArrowClockwise, Broom, Check, Clock, ClockClockwise, Plus, Star, X } from "@phosphor-icons/react";
import { springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { Segmented } from "../../ui/controls";
import { formatTime } from "../../lib/format";
import { locale, t } from "../../i18n";
import { DEFAULT_PROJECT, TASK_COLORS, nextTask, sortTasks, type Project, type Task, type TaskColor } from "./model";
import { dayDiff, defaultDay, dueAt, parseTime } from "./schedule";
import { dueTasks, googleTasksConnected, googleTasksLoading, googleUserEmail, syncGoogleTasks, todoActions, todos } from "./store";
import { colorVar } from "./colors";
import { DateChip, useDraftDate } from "./DraftDate";

/*
 *  ┌ Projects ───────┐ ┌ + New task ─────────────── 3 open ┐
 *  │ ● Personal   3  │ │ ○ Reply to Dina          14:30 ☆ │
 *  │   Reply to Dina │ │ ○ Post weekly update   Tomorrow  │
 *  │   Work       1  │ │ ✓ Revise the report              │
 *  │ + New project   │ └──────────────────────────────────┘
 *  └─────────────────┘
 * Each project shows its next task under its name, so switching is rarely needed to know what comes next.
 */
export function TodosView() {
  const { projects, active, tasks } = todos.use();
  const due = dueTasks.use();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const mine = sortTasks(tasks.filter((x) => x.projectId === active));
  const open = mine.filter((x) => !x.done).length;
  const ringing = new Set(due.map((x) => x.id));
  const now = useMinute();
  const date = useDraftDate(draft, now);
  // Opened for a reminder: show the project it belongs to.
  useEffect(() => {
    const first = dueTasks.get()[0];
    if (first && !dueTasks.get().some((x) => x.projectId === todos.get().active)) todoActions.setActive(first.projectId);
  }, []);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    const task = date.apply(text);
    todoActions.add(task.text, task.due);
    setDraft("");
  };

  const isGoogle = googleTasksConnected.use();
  const loading = googleTasksLoading.use();
  const userEmail = googleUserEmail.use();

  return (
    <div className="flex h-full gap-3 px-4 pt-1 pb-1">
      <HeaderActions>
        <HeaderButton
          label={isGoogle ? t("Google Tasks synchronisieren") : t("Mit Google Tasks verbinden")}
          onClick={() => (isGoogle ? syncGoogleTasks() : todoActions.connectGoogle())}
        >
          <ArrowClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} />
        </HeaderButton>
        {mine.some((x) => x.done) && (
          <HeaderButton label={t("Erledigte entfernen")} onClick={() => todoActions.clearDone(active)}>
            <Broom size={14} weight="bold" />
          </HeaderButton>
        )}
      </HeaderActions>
      <Projects projects={projects} active={active} tasks={tasks} ringing={new Set(due.map((x) => x.projectId))} isGoogle={isGoogle} userEmail={userEmail} onSync={syncGoogleTasks} onConnect={todoActions.connectGoogle} />

      <div className="flex min-w-0 flex-1 flex-col">
        <form
          className="flex h-9 shrink-0 items-center gap-2 rounded-[12px] bg-fill-1 px-3"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Plus size={14} weight="bold" className="text-label-3" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("Neue Aufgabe")}
            className="min-w-0 flex-1 bg-transparent text-body text-label outline-none placeholder:text-label-4"
          />
          <span className="tabular text-caption text-label-3">{t("{n} offen", { n: open })}</span>
        </form>
        <DateChip date={date} now={now} />

        <div className="-mx-1 mt-1.5 flex-1 overflow-y-auto px-1 [scrollbar-width:none]">
          {mine.length === 0 && <div className="flex h-full items-center justify-center text-body text-label-3">{t("Nichts offen")}</div>}
          <AnimatePresence initial={false}>
            {mine.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                now={now}
                ringing={ringing.has(task.id)}
                editing={editing === task.id}
                onEdit={() => setEditing((e) => (e === task.id ? null : task.id))}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** Date.now(), refreshed on each new minute (due labels and "overdue"). */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let id = 0;
    const next = () => {
      setNow(Date.now());
      id = window.setTimeout(next, 60_000 - (Date.now() % 60_000) + 50);
    };
    id = window.setTimeout(next, 60_000 - (Date.now() % 60_000) + 50);
    return () => window.clearTimeout(id);
  }, []);
  return now;
}

function Projects({
  projects,
  active,
  tasks,
  ringing,
  isGoogle,
  userEmail,
  onSync,
  onConnect,
}: {
  projects: Project[];
  active: string;
  tasks: Task[];
  ringing: Set<string>;
  isGoogle: boolean;
  userEmail: string | null;
  onSync: () => void;
  onConnect: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <nav className="-ms-1 flex w-[160px] shrink-0 flex-col">
      {/* Google Tasks connection banner / indicator */}
      <div className="mb-1 flex items-center justify-between px-2 py-1 rounded-[8px] bg-fill-1 text-caption text-label-3">
        <span className="flex items-center gap-1.5 truncate">
          <span className={`h-1.5 w-1.5 rounded-full ${isGoogle ? "bg-emerald-500" : "bg-label-4"}`} />
          <span className="truncate">{isGoogle ? userEmail || "Google Tasks" : "Local Tasks"}</span>
        </span>
        {isGoogle ? (
          <button
            onClick={onSync}
            className="pressable text-label-3 hover:text-label p-0.5"
            title={t("Google Tasks synchronisieren")}
          >
            <ArrowClockwise size={11} weight="bold" />
          </button>
        ) : (
          <button
            onClick={onConnect}
            className="pressable text-accent font-medium hover:underline text-[11px]"
            title={t("Mit Google Tasks verbinden")}
          >
            Google
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto [scrollbar-width:none]">
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            active={p.id === active}
            ringing={ringing.has(p.id)}
            open={tasks.filter((x) => x.projectId === p.id && !x.done).length}
            next={nextTask(tasks, p.id)}
            deletable={projects.length > 1 && !isGoogle}
          />
        ))}
        {adding && (
          <div className="px-2 py-1.5">
            <NameInput
              initial=""
              placeholder={t("Projektname")}
              onDone={(name) => {
                setAdding(false);
                if (name) todoActions.addProject(name);
              }}
            />
          </div>
        )}
      </div>
      <button onClick={() => setAdding(true)} className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-footnote text-label-3 hover:text-label-2">
        <Plus size={12} weight="bold" /> {t("Neues Projekt")}
      </button>
    </nav>
  );
}

/** The built-in first project is stored in English; show it in the interface language until it is renamed. */
const projectName = (p: Project) => (p.id === DEFAULT_PROJECT.id && p.name === DEFAULT_PROJECT.name ? t("Persönlich") : p.name);

function ProjectRow(props: { project: Project; active: boolean; ringing: boolean; open: number; next: Task | null; deletable: boolean }) {
  const { project, active, ringing, open, next, deletable } = props;
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const id = window.setTimeout(() => setConfirm(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirm]);

  return (
    <div className="group relative">
      <button
        onClick={() => todoActions.setActive(project.id)}
        onDoubleClick={() => setRenaming(true)}
        aria-current={active ? "true" : undefined}
        title={t("Doppelklick zum Umbenennen")}
        className={`pressable relative flex w-full flex-col rounded-[8px] px-2 py-1 text-start ${active ? "text-label" : "text-label-3 hover:text-label-2"}`}
      >
        {active && <motion.span layoutId="todo-project" className="absolute inset-0 rounded-[8px] bg-fill-2" transition={springs.snappy} />}
        <span className="relative flex w-full items-center gap-1.5">
          {renaming ? (
            <NameInput
              initial={projectName(project)}
              onDone={(name) => {
                setRenaming(false);
                if (name) todoActions.renameProject(project.id, name);
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-body font-medium">{projectName(project)}</span>
          )}
          {ringing && <AlarmIcon size={11} weight="fill" className="shrink-0 text-orange" aria-label={t("Zeit ist um")} />}
          {!renaming && <span className={`tabular text-caption text-label-3 ${deletable ? "group-hover:opacity-0" : ""}`}>{open || ""}</span>}
        </span>
        <span className="relative w-full truncate text-caption text-label-3">{next ? next.text : t("Nichts offen")}</span>
      </button>
      {deletable && !renaming && (
        <button
          aria-label={confirm ? t("Projekt mit Aufgaben löschen") : t("Projekt löschen")}
          title={confirm ? t("Projekt mit Aufgaben löschen") : t("Projekt löschen")}
          onClick={() => (confirm ? todoActions.removeProject(project.id) : setConfirm(true))}
          className={`pressable absolute top-1 end-1 flex h-[18px] items-center justify-center rounded-full px-1 text-caption ${
            confirm ? "bg-red text-black opacity-100" : "text-label-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-label-2"
          }`}
        >
          {confirm ? t("Löschen?") : <X size={11} weight="bold" />}
        </button>
      )}
    </div>
  );
}

/** A text field that saves on Enter or blur and cancels on Escape. */
function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  // Enter unmounts the field, which can still fire a blur: report once.
  const finished = useRef(false);
  const finish = (v: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(v === null ? null : v.trim() || null);
  };
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(value)}
      className="min-w-0 flex-1 rounded-[6px] bg-fill-2 px-1.5 text-body text-label outline-none placeholder:text-label-4"
    />
  );
}

/** "14:30", "Tomorrow 09:00", "Sat 14:30", "3 Nov". */
export function dueLabel(due: number, now: number): string {
  const d = dayDiff(now, due);
  if (d === 0) return formatTime(due);
  if (d === 1) return `${t("Morgen")} ${formatTime(due)}`;
  if (d === -1) return t("Gestern");
  if (d > 1 && d < 7) return `${new Intl.DateTimeFormat(locale(), { weekday: "short" }).format(due)} ${formatTime(due)}`;
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" }).format(due);
}

function TaskRow({ task, now, ringing, editing, onEdit }: { task: Task; now: number; ringing: boolean; editing: boolean; onEdit: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const color = colorVar(task.color);
  const overdue = !task.done && task.due !== null && task.due <= now;
  return (
    <motion.div
      layout="position"
      transition={springs.snappy}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: editing ? 66 : 32 }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
      className={`group overflow-hidden rounded-[10px] px-2 ${editing ? "bg-fill-1" : "hover:bg-fill-1"}`}
    >
      <div className="flex h-8 items-center gap-2.5">
        <button
          aria-label={task.done ? t("Als offen markieren") : t("Erledigt")}
          onClick={() => todoActions.toggleDone(task.id)}
          className={`pressable flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] ${task.done ? "border-green bg-green text-black" : color ? "" : "border-label-3"}`}
          style={!task.done && color ? { borderColor: color } : undefined}
        >
          <AnimatePresence initial={false}>
            {task.done && (
              <motion.span
                className="flex"
                initial={{ opacity: 0, transform: "scale(0.5)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.5)" }}
                transition={springs.snappy}
              >
                <Check size={11} weight="bold" />
              </motion.span>
            )}
          </AnimatePresence>
        </button>
        {renaming ? (
          <NameInput
            initial={task.text}
            onDone={(text) => {
              setRenaming(false);
              if (text) todoActions.patch(task.id, { text });
            }}
          />
        ) : (
          <span
            dir="auto"
            onDoubleClick={() => setRenaming(true)}
            title={task.text}
            className={`min-w-0 flex-1 truncate text-body transition-colors duration-200 ${task.done ? "text-label-3 line-through" : "text-label"}`}
          >
            {task.text}
          </span>
        )}
        {ringing ? (
          <>
            <span className="flex shrink-0 items-center gap-1 text-caption font-medium text-orange">
              <AlarmIcon size={12} weight="fill" /> {t("Zeit ist um")}
            </span>
            <button aria-label={t("10 Min. später")} title={t("10 Min. später")} onClick={() => todoActions.snooze(task.id)} className="pressable flex size-6 items-center justify-center text-label-2 hover:text-label">
              <ClockClockwise size={14} weight="bold" />
            </button>
          </>
        ) : (
          task.due !== null && !task.done && <span className={`tabular shrink-0 text-caption ${overdue ? "text-orange" : "text-label-3"}`}>{dueLabel(task.due, now)}</span>
        )}
        <button
          aria-label={t("Zeit und Farbe")}
          title={t("Zeit und Farbe")}
          onClick={onEdit}
          className={`pressable flex size-6 items-center justify-center ${editing ? "text-label" : "text-label-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-label-2"}`}
        >
          <Clock size={14} weight="bold" />
        </button>
        <button
          aria-label={t("Markieren")}
          onClick={() => todoActions.patch(task.id, { starred: !task.starred })}
          className={`pressable flex size-6 items-center justify-center ${task.starred ? "text-yellow" : "text-label-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        >
          <Star size={14} weight={task.starred ? "fill" : "bold"} />
        </button>
        <button
          aria-label={t("Löschen")}
          onClick={() => todoActions.remove(task.id)}
          className="pressable flex size-6 items-center justify-center text-label-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-label-2"
        >
          <X size={13} weight="bold" />
        </button>
      </div>
      {editing && <TaskDetails task={task} onClose={onEdit} />}
    </motion.div>
  );
}

/** "14:30" in every language and clock setting, so parseTime always reads it back. */
const clock24 = (at: number) => `${new Date(at).getHours()}:${String(new Date(at).getMinutes()).padStart(2, "0")}`;

/** Second line of an open row: colour, due time (typed) and day. */
function TaskDetails({ task, onClose }: { task: Task; onClose: () => void }) {
  const now = Date.now();
  const [time, setTime] = useState(task.due !== null ? clock24(task.due) : "");
  const parsed = parseTime(time);
  // null = automatic: today while the typed time is still ahead, else tomorrow. Only a saved "tomorrow" that
  // automatic would read as today (tomorrow 15:00, now 14:00) is kept as a choice; anything else, including a
  // time already past today, follows the typed time.
  const [day, setDay] = useState<"0" | "1" | null>(() => {
    if (task.due === null || dayDiff(now, task.due) !== 1) return null;
    const d = new Date(task.due);
    return defaultDay(now, d.getHours(), d.getMinutes()) === 0 ? "1" : null;
  });
  const chosenDay = day ?? (parsed ? String(defaultDay(now, parsed.h, parsed.m)) : "0");
  const save = () => {
    if (!parsed) return;
    todoActions.setDue(task.id, dueAt(Date.now(), Number(chosenDay), parsed.h, parsed.m));
    onClose();
  };
  return (
    <div className="flex h-[30px] items-center gap-2 ps-7">
      <div className="flex items-center gap-1" role="radiogroup" aria-label={t("Farbe")}>
        {[null, ...TASK_COLORS].map((c) => (
          <button
            key={c ?? "none"}
            role="radio"
            aria-checked={task.color === c}
            aria-label={c ? t(COLOR_NAMES[c]) : t("Keine Farbe")}
            title={c ? t(COLOR_NAMES[c]) : t("Keine Farbe")}
            onClick={() => todoActions.patch(task.id, { color: c })}
            className={`pressable size-3.5 rounded-full ${task.color === c ? "ring-2 ring-label ring-offset-1 ring-offset-black" : ""} ${c ? "" : "border border-label-3"}`}
            style={c ? { background: colorVar(c)! } : undefined}
          />
        ))}
      </div>
      <span className="mx-1 h-4 w-px bg-separator" />
      <input
        value={time}
        onChange={(e) => setTime(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        placeholder={t("z. B. 14:30")}
        aria-label={t("Zeit")}
        className={`tabular h-6 w-[72px] rounded-[6px] bg-fill-2 px-1.5 text-footnote text-label outline-none placeholder:text-label-4 ${time && !parsed ? "ring-1 ring-red" : ""}`}
      />
      <Segmented
        id={`due-day-${task.id}`}
        size="sm"
        value={chosenDay as "0" | "1"}
        onChange={(v) => setDay(v)}
        options={[
          { value: "0", label: t("Heute") },
          { value: "1", label: t("Morgen") },
        ]}
      />
      <button onClick={save} disabled={!parsed} className="pressable h-6 rounded-full bg-label px-2.5 text-caption font-medium text-black disabled:opacity-35">
        {t("Erinnern")}
      </button>
      {task.due !== null && (
        <button
          onClick={() => {
            todoActions.setDue(task.id, null);
            onClose();
          }}
          className="pressable h-6 rounded-full px-2 text-caption text-label-3 hover:text-label-2"
        >
          {t("Ohne Zeit")}
        </button>
      )}
    </div>
  );
}

const COLOR_NAMES: Record<TaskColor, string> = { red: "Rot", orange: "Orange", yellow: "Gelb", green: "Grün", blue: "Blau" };
