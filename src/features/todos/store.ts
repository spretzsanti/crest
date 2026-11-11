import { createStore } from "../../lib/store";
import { alarmRinging, playAlarm } from "../../lib/sound";
import { settings } from "../../settings/store";
import {
  googleAuthStatus,
  googleAuthStart,
  googleAuthDisconnect,
  gtasksListLists,
  gtasksListTasks,
  gtasksCreateTask,
  gtasksPatchTask,
  gtasksDeleteTask,
  type GTaskItem,
} from "../../platform/services";
import { DEFAULT_PROJECT, migrate, type Project, type Task, type TodoState } from "./model";
import { MAX_WAIT_MS, dueReminders, nextAlert, snoozeAt, wait } from "./schedule";

const KEY = "notch:todo-projects";
/** The flat list of Crest 0.2 and earlier. Read once to migrate, never written or deleted, so an older version still finds it. */
const LEGACY_KEY = "notch:todos";

function readRaw(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const hadState = readRaw(KEY) !== null;
export const todos = createStore<TodoState>({ projects: [DEFAULT_PROJECT], active: DEFAULT_PROJECT.id, tasks: [] }, { persist: "todo-projects" });
todos.set((s) => migrate(hadState ? s : null, hadState ? null : readRaw(LEGACY_KEY), Date.now()));

/** Tasks whose reminder rings now, oldest first. Set by the scheduler, empty while the To-do tool is off. */
export const dueTasks = createStore<Task[]>([]);

/** Google Tasks synchronization state */
export const googleTasksConnected = createStore<boolean>(false);
export const googleTasksLoading = createStore<boolean>(false);
export const googleUserEmail = createStore<string | null>(null);

const patchTask = (id: string, p: Partial<Task> | ((t: Task) => Partial<Task>)) =>
  todos.set((s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...(typeof p === "function" ? p(t) : p) } : t)) }));

function gtaskToTask(item: GTaskItem, projectId: string): Task {
  const isDone = item.status === "completed";
  const due = item.due ? new Date(item.due).getTime() : null;
  return {
    id: item.id,
    projectId,
    text: item.title,
    done: isDone,
    starred: false,
    color: null,
    due,
    alertAt: isDone ? null : due,
    createdAt: item.updated ? new Date(item.updated).getTime() : Date.now(),
    doneAt: isDone && item.completed ? new Date(item.completed).getTime() : isDone ? Date.now() : null,
  };
}

export async function syncGoogleTasks(): Promise<void> {
  try {
    googleTasksLoading.set(true);
    const status = await googleAuthStatus();
    googleTasksConnected.set(status.connected);
    googleUserEmail.set(status.email);

    if (!status.connected) {
      googleTasksLoading.set(false);
      return;
    }

    const lists = await gtasksListLists();
    if (lists.length > 0) {
      const projects: Project[] = lists.map((l) => ({ id: l.id, name: l.title }));
      const currentActive = todos.get().active;
      const active = projects.some((p) => p.id === currentActive) ? currentActive : projects[0].id;

      // Fetch tasks for all lists in parallel
      const tasksByList = await Promise.all(
        lists.map(async (l) => {
          try {
            const items = await gtasksListTasks(l.id);
            return items.map((i) => gtaskToTask(i, l.id));
          } catch {
            return [];
          }
        }),
      );

      const allTasks = tasksByList.flat();

      todos.set((prev) => {
        // Keep any unsynced local tasks that might exist if needed
        return {
          projects,
          active,
          tasks: allTasks.length > 0 ? allTasks : prev.tasks,
        };
      });
    }
  } catch (e) {
    console.error("Failed to sync Google Tasks:", e);
  } finally {
    googleTasksLoading.set(false);
  }
}

export const todoActions = {
  add(text: string, due: number | null = null) {
    const now = Date.now();
    const tempId = crypto.randomUUID();
    const active = todos.get().active;
    const newTask: Task = {
      id: tempId,
      projectId: active,
      text,
      done: false,
      starred: false,
      color: null,
      due,
      alertAt: due,
      createdAt: now,
      doneAt: null,
    };

    todos.set((s) => ({
      ...s,
      tasks: [newTask, ...s.tasks],
    }));

    if (googleTasksConnected.get()) {
      const dueStr = due ? new Date(due).toISOString() : undefined;
      gtasksCreateTask(active, text, undefined, dueStr)
        .then((created) => {
          todos.set((s) => ({
            ...s,
            tasks: s.tasks.map((t) => (t.id === tempId ? { ...t, id: created.id } : t)),
          }));
        })
        .catch((err) => console.error("gtasksCreateTask error:", err));
    }
  },

  patch: (id: string, p: Partial<Pick<Task, "text" | "starred" | "color">>) => {
    patchTask(id, p);
    if (googleTasksConnected.get() && p.text !== undefined) {
      const task = todos.get().tasks.find((t) => t.id === id);
      if (task) {
        gtasksPatchTask(task.projectId, id, task.done ? "completed" : "needsAction", p.text)
          .catch((err) => console.error("gtasksPatchTask error:", err));
      }
    }
  },

  remove: (id: string) => {
    const task = todos.get().tasks.find((t) => t.id === id);
    todos.set((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== id) }));
    if (googleTasksConnected.get() && task) {
      gtasksDeleteTask(task.projectId, id).catch((err) => console.error("gtasksDeleteTask error:", err));
    }
  },

  /** A new due time also re-arms the reminder; null removes both. */
  setDue: (id: string, due: number | null) => {
    patchTask(id, { due, alertAt: due });
    if (googleTasksConnected.get()) {
      const task = todos.get().tasks.find((t) => t.id === id);
      if (task) {
        const dueStr = due ? new Date(due).toISOString() : undefined;
        gtasksPatchTask(task.projectId, id, task.done ? "completed" : "needsAction", undefined, undefined, dueStr)
          .catch((err) => console.error("gtasksPatchTask error:", err));
      }
    }
  },

  toggleDone: (id: string) => {
    let newDone = false;
    patchTask(id, (t) => {
      newDone = !t.done;
      return t.done
        ? { done: false, doneAt: null, alertAt: t.due !== null && t.due > Date.now() ? t.due : null }
        : { done: true, doneAt: Date.now(), alertAt: null };
    });
    if (googleTasksConnected.get()) {
      const task = todos.get().tasks.find((t) => t.id === id);
      if (task) {
        gtasksPatchTask(task.projectId, id, newDone ? "completed" : "needsAction")
          .catch((err) => console.error("gtasksPatchTask error:", err));
      }
    }
  },

  done: (id: string) => {
    patchTask(id, { done: true, doneAt: Date.now(), alertAt: null });
    if (googleTasksConnected.get()) {
      const task = todos.get().tasks.find((t) => t.id === id);
      if (task) {
        gtasksPatchTask(task.projectId, id, "completed")
          .catch((err) => console.error("gtasksPatchTask error:", err));
      }
    }
  },

  snooze: (id: string) => patchTask(id, { alertAt: snoozeAt(Date.now()) }),

  clearDone: (projectId: string) => {
    const toClear = todos.get().tasks.filter((t) => t.projectId === projectId && t.done);
    todos.set((s) => ({ ...s, tasks: s.tasks.filter((t) => !(t.projectId === projectId && t.done)) }));
    if (googleTasksConnected.get()) {
      for (const t of toClear) {
        gtasksDeleteTask(projectId, t.id).catch(() => {});
      }
    }
  },

  addProject(name: string) {
    const id = crypto.randomUUID();
    todos.set((s) => ({ ...s, projects: [...s.projects, { id, name }], active: id }));
  },
  renameProject: (id: string, name: string) => todos.set((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)) })),
  /** Deletes the project with its tasks; the last project stays. */
  removeProject: (id: string) =>
    todos.set((s) => {
      if (s.projects.length <= 1) return s;
      const projects = s.projects.filter((p) => p.id !== id);
      return { projects, active: s.active === id ? projects[0].id : s.active, tasks: s.tasks.filter((t) => t.projectId !== id) };
    }),
  setActive: (id: string) => todos.set((s) => ({ ...s, active: id })),

  async connectGoogle() {
    await googleAuthStart();
    await syncGoogleTasks();
  },
  async disconnectGoogle() {
    await googleAuthDisconnect();
    googleTasksConnected.set(false);
    googleUserEmail.set(null);
  },
};

// One scheduler for the whole app: a timeout to the next reminder (at most a minute, so standby and clock
// changes are caught), nothing while no reminder is pending or the To-do tool is off.
let timeout: number | undefined;
let lastKey = "";
const rung = new Set<string>();

function check() {
  window.clearTimeout(timeout);
  const now = Date.now();
  const { tasks } = todos.get();
  const s = settings.get();
  const on = s.tools.some((t) => t.id === "todos" && t.enabled);
  const due = on ? dueReminders(tasks, now) : [];

  // One chime per reminder that has just come due (not for ones missed while the app was closed), never over a ringing timer.
  let fresh = false;
  for (const t of due) {
    const k = `${t.id}:${t.alertAt}`;
    if (!rung.has(k)) {
      rung.add(k);
      if (t.alertAt! > now - 2 * MAX_WAIT_MS) fresh = true;
    }
  }
  if (fresh && s.productivity.reminderSound && !alarmRinging()) playAlarm(s.alarm.sound, s.alarm.volume, 0);

  const key = due.map((t) => `${t.id}:${t.alertAt}:${t.text}:${t.color}`).join("|");
  if (key !== lastKey) {
    lastKey = key;
    dueTasks.set(due);
  }
  const delay = on ? wait(nextAlert(tasks, now), now) : null;
  if (delay !== null) timeout = window.setTimeout(check, delay + 20);
}

export function startTodoReminders() {
  todos.subscribe(check);
  settings.subscribe(check);
  check();
  // Initial sync attempt for Google Tasks
  void syncGoogleTasks();
}
