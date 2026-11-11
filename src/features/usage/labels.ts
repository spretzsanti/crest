import { t } from "../../i18n";

export const windowLabels: Record<string, string> = {
  weekly: "Woche",
  "weekly-opus": "Woche · Opus",
  "weekly-sonnet": "Woche · Sonnet",
  "session-3p": "Session · Claude/GPT",
  "weekly-3p": "Woche · Claude/GPT",
  daily: "Heute",
  monthly: "Monat",
  "key-limit": "Schlüssellimit",
  "monthly-tools": "Tool-Aufrufe im Monat",
};

/** The limit window's name, translated ("model:Opus" is just "Opus"). */
export function windowLabel(kind: string): string {
  return kind.startsWith("model:") ? kind.slice(6) : t(windowLabels[kind] ?? kind);
}
