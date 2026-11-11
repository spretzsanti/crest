import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowClockwise, Gauge, SlidersHorizontal, Table, WarningCircle } from "@phosphor-icons/react";
import { content, spin, springs } from "../../design/motion";
import { formatAgo, formatIn } from "../../lib/format";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { requestSize } from "../../notch/size";
import { findTab } from "../../notch/tabs";
import type { UsageBalance, UsageId, UsageProvider, UsageWindow } from "../../platform/services";
import { isMac, isNative } from "../../platform/native";
import { settings } from "../../settings/store";
import { runInTerminal } from "../terminal/session";
import { BrandLogo, brandName } from "../../ui/brands";
import { Button, Empty, Skeleton } from "../../ui/controls";
import { t } from "../../i18n";
import { shownIds } from "./cards";
import { ModelDetails } from "./ModelDetails";
import { PaceLine, usePaceGrow } from "./PaceLine";
import { refreshTokens, refreshUsage, usage, useTokens, useUsageViewer } from "./store";
import { formatAmount, formatCost, formatTokens } from "./format";
import { dayStart, totals, type Totals } from "./tokens";
import { usePresenting } from "../privacy/store";

/** What a stale card adds: its reason on up to two lines and the renew link. */
const STALE_ROWS = 56;

import { windowLabel, windowLabels } from "./labels";
export { windowLabel, windowLabels };


export const usageError: Record<string, string> = {
  "not-found": "Nicht auf diesem Gerät gefunden",
  "not-signed-in": "Nicht angemeldet",
  expired: "Anmeldung abgelaufen, App kurz öffnen",
  "claude-expired": "Anmeldung abgelaufen: einmal claude im Terminal starten",
  "no-key": "Noch kein API-Schlüssel",
  "bad-key": "Schlüssel abgelehnt, in den Einstellungen prüfen",
  "rate-limited": "Gerade gedrosselt, nächster Versuch in ein paar Minuten",
  offline: "Keine Verbindung",
  failed: "Abruf fehlgeschlagen",
};

/**
 * What a "not found" card needs, per tool: Crest reads the command line tools' sign-in, and people often have only the
 * desktop app (issue #9). Antigravity's app is read while it runs, so opening it is enough.
 */
const notFoundHint: Partial<Record<UsageId, string>> = {
  claude: "Braucht Claude Code im Terminal oder den Sitzungsschlüssel von claude.ai in den Einstellungen",
  codex: "Braucht die Codex-CLI. Die Grenzen des ChatGPT-Chats lassen sich nicht abrufen",
  gemini: "Antigravity öffnen oder die agy-CLI installieren",
};

const balanceLabels: Record<string, string> = {
  account: "Guthaben",
  key: "Schlüssel übrig",
  budget: "Budget übrig",
  granted: "Davon geschenkt",
  today: "Heute ausgegeben",
  month: "Diesen Monat",
};

/** Which card shows the tokens of which local log. */
const TOKEN_TOOL: Partial<Record<UsageId, "claude" | "codex">> = { claude: "claude", codex: "codex" };

/*
 *   ┌ ✳ Claude  Max ───────┐ ┌ ⌘ ChatGPT  Plus ─────┐
 *   │ Session      44 %    │ │ Session      71 %    │
 *   │ ━━━━━━━━━──────────── │ │ ━━━━━━━━━━━━━━━───── │
 *   │ in 2 h     56 % left │ │ in 48 min  29 % left │
 *   │ ──────────────────── │ │ ──────────────────── │
 *   │ Today   1.2M  $3.40  │ │ Today   310K  $0.42  │
 *   │ 7 days  8.4M  $21.10 │ │ 7 days  2.1M  $3.05  │
 *   └──────────────────────┘ └──────────────────────┘
 * Like OmniNotch: one card per provider, one bar per limit window; tokens and cost from the local logs at the foot (as BrimDeck).
 */
export function UsageView() {
  useUsageViewer();
  const s = settings.use();
  // Crest's terminal: Windows only, and only while the tool is in the tool bar.
  const terminalShown = isNative && !isMac && s.tools.some((x) => x.id === "terminal" && x.enabled);
  const ids = shownIds(s.aiUsage.order, s.usage);
  const { providers, loading, updatedAt } = usage.use();
  const [page, setPage] = useState<"cards" | "models">("cards");
  const [tick, setTick] = useState(Date.now);
  // "x ago" moves every 30 s and with every answer.
  const now = Math.max(tick, updatedAt ?? 0);
  const feet = page === "cards" && ids.some((id) => TOKEN_TOOL[id]);
  const tok = useTokens(feet || page === "models");

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // A card kept from an old reading adds its reason and the renew link above its time: the panel grows by them.
  const stale = providers.some((p) => p.error && (p.windows?.length || p.balances?.length));
  // The pace lines under the bars (PaceLine.tsx) make the panel taller the same way.
  const paceGrow = usePaceGrow(providers, now);
  useEffect(() => {
    const grow = (stale ? STALE_ROWS : 0) + paceGrow;
    const base = findTab("usage")!.size;
    requestSize("usage", page === "models" ? { w: 700, h: 430 } : feet ? { w: 600, h: 356 + grow } : grow ? { w: base.w, h: base.h + grow } : null);
  }, [page, feet, stale, paceGrow]);
  useEffect(() => () => requestSize("usage", null), []);

  const actions = (
    <HeaderActions>
      <HeaderButton
        label={t("Aktualisieren")}
        onClick={() => {
          void refreshUsage();
          if (feet || page === "models") refreshTokens();
        }}
      >
        <motion.span className="flex" animate={{ rotate: loading || tok.loading ? 360 : 0 }} transition={loading || tok.loading ? spin : { duration: 0 }}>
          <ArrowClockwise size={14} weight="bold" />
        </motion.span>
      </HeaderButton>
      <HeaderButton label={t("Modelle")} active={page === "models"} onClick={() => setPage((p) => (p === "models" ? "cards" : "models"))}>
        <Table size={14} weight="bold" />
      </HeaderButton>
      <HeaderButton label={t("Anbieter verwalten")} onClick={() => navigate("settings", "usage")}>
        <SlidersHorizontal size={14} weight="bold" />
      </HeaderButton>
    </HeaderActions>
  );

  if (page === "models") {
    return (
      <>
        {actions}
        <ModelDetails state={tok} />
      </>
    );
  }

  if (ids.length === 0) {
    return (
      <>
        {actions}
        <Empty
          icon={Gauge}
          title={t("Keine Anbieter aktiv")}
          text={t("Wähle in den Einstellungen, welche AI-Abos angezeigt werden.")}
          action={<Button onClick={() => navigate("settings", "usage")}>{t("Anbieter wählen")}</Button>}
        />
      </>
    );
  }

  const list: (Partial<UsageProvider> & { id: UsageId })[] = updatedAt === null ? ids.map((id) => ({ id })) : providers;
  const today = dayStart(now, 0), week = dayStart(now, 6);
  return (
    <div className="flex h-full gap-2 overflow-x-auto px-4 pt-1 pb-2 [scrollbar-width:none]">
      {actions}
      {list.map((p, i) => {
        const tool = TOKEN_TOOL[p.id];
        const logs = tool && tok.report?.tools.find((x) => x.id === tool);
        const hasData = !!p.windows?.length || !!p.balances?.length;
        const hint = p.error === "not-found" ? notFoundHint[p.id] : undefined;
        const status = p.error ? (p.error === "rate-limited" && p.retryAt ? t("Gedrosselt, nächster Versuch {in}", { in: formatIn(p.retryAt - now) }) : t(hint ?? usageError[p.error] ?? p.error)) : undefined;
        return (
          <motion.div
            key={p.id}
            className="flex min-w-[168px] flex-1 flex-col rounded-[14px] bg-fill-1 px-3 py-2.5"
            initial={{ opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            transition={{ ...content.enter, delay: 0.05 * i }}
          >
            <div className="mb-2 flex items-center gap-1.5">
              <BrandLogo id={p.id} size={14} className="shrink-0 text-label" />
              <span className="truncate text-footnote font-semibold text-label">{s.aiUsage.names[p.id] || brandName[p.id]}</span>
              {p.plan && <span className="truncate rounded-full bg-fill-2 px-1.5 text-caption text-label-2">{p.plan}</span>}
            </div>
            {!p.windows ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            ) : !hasData ? (
              <div className="flex flex-1 flex-col items-start justify-center gap-1 pb-2 text-caption text-label-3">
                <WarningCircle size={14} weight="bold" />
                {status ?? t(usageError.failed)}
                {(p.error === "no-key" || p.error === "bad-key") && (
                  <button className="text-link hover:underline" onClick={() => navigate("settings", "usage")}>
                    {t("Schlüssel eintragen")}
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Kept from the last good answer: dimmed while it can't be refreshed (a 429 pause clears itself, so it stays). */}
                <div className={`flex flex-col gap-2 transition-opacity duration-200 ${p.error && p.error !== "rate-limited" ? "opacity-50" : ""}`}>
                  {p.windows.map((w) => (
                    <div key={w.kind}>
                      <WindowRow w={w} now={now} />
                      <PaceLine w={w} now={now} readAt={p.updatedAt!} error={p.error} />
                    </div>
                  ))}
                  {p.balances?.map((b) => <BalanceRow key={b.kind + b.currency} b={b} />)}
                </div>
                <div className="mt-auto pt-2 text-caption text-label-4">
                  {status && (
                    <div className="mb-0.5 flex items-start gap-1 text-label-3">
                      <WarningCircle size={12} weight="bold" className="mt-px shrink-0" />
                      <span>{status}</span>
                    </div>
                  )}
                  {/* Starting claude once renews its sign-in, which Crest then reads (Windows: Crest's terminal is Windows only). */}
                  {p.error === "claude-expired" && terminalShown && (
                    <button
                      className="mb-1 block text-link hover:underline"
                      onClick={() => {
                        runInTerminal("claude");
                        navigate("terminal");
                      }}
                    >
                      {t("Im Terminal erneuern")}
                    </button>
                  )}
                  {p.error ? t("Stand {ago}", { ago: formatAgo(now - p.updatedAt!) }) : formatAgo(now - p.updatedAt!)}
                </div>
              </>
            )}
            {/* Not found and no logs: the foot would only push this card's message off the line of its neighbours'. */}
            {tool && (hasData || logs?.found) && <TokenFoot found={logs ? logs.found : null} failed={tok.failed} today={logs ? totals(logs.buckets, today, s.aiUsage.prices) : null} week={logs ? totals(logs.buckets, week, s.aiUsage.prices) : null} />}
          </motion.div>
        );
      })}
    </div>
  );
}

function WindowRow({ w, now }: { w: UsageWindow; now: number }) {
  const used = Math.max(0, Math.min(100, w.usedPercent));
  const label = windowLabel(w.kind);
  const fill = used >= 90 ? "var(--color-red)" : used >= 70 ? "var(--color-orange)" : "var(--color-label)";

  return (
    <div className="text-caption">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="truncate text-label-2">{label}</span>
        <span className="tabular font-semibold text-label">{Math.round(used)} %</span>
      </div>
      <div className="relative h-[5px] overflow-hidden rounded-full bg-fill-2 rtl:-scale-x-100">
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{ backgroundColor: fill }}
          initial={{ transform: "translateX(-100%)" }}
          animate={{ transform: `translateX(${used - 100}%)` }}
          transition={springs.morph}
        />
      </div>
      {/* Wraps instead of cutting the reset time off: in Russian or German the two do not fit side by side. */}
      <div className="tabular mt-1 flex flex-wrap justify-between gap-x-2 text-label-3">
        <span title={t("Setzt sich zurück")}>{w.resetsAt ? formatIn(w.resetsAt - now) : ""}</span>
        <span className={`ms-auto whitespace-nowrap ${used >= 90 ? "text-red" : ""}`}>{t("{n} % übrig", { n: Math.round(100 - used) })}</span>
      </div>
    </div>
  );
}

/** Money stays hidden in presentation mode, as in Trading. */
function BalanceRow({ b }: { b: UsageBalance }) {
  const hidden = usePresenting();
  const amount = (v: number) => (hidden ? "••••••" : formatAmount(v, b.currency));
  return (
    <div className="flex items-baseline justify-between gap-2 text-caption">
      <span className="truncate text-label-2">{t(balanceLabels[b.kind] ?? b.kind)}</span>
      <span className="tabular shrink-0 font-semibold text-label">
        {amount(b.amount)}
        {b.total !== null && <span className="font-normal text-label-3"> / {amount(b.total)}</span>}
      </span>
    </div>
  );
}

/** Today and the last 7 days from the tool's local logs. `found` null = not read yet; `failed` = the read failed before any report came. */
function TokenFoot({ found, failed, today, week }: { found: boolean | null; failed: boolean; today: Totals | null; week: Totals | null }) {
  const tip = t("Aus den Protokollen auf diesem PC, zu API-Listenpreisen");
  return (
    <div className="mt-2 border-t border-separator pt-1.5 text-caption" title={tip}>
      {found === null && failed ? (
        <div className="py-0.5 text-label-4">{t("Protokolle nicht lesbar")}</div>
      ) : found === null ? (
        <div className="flex flex-col gap-1.5 py-0.5">
          <Skeleton className="h-2.5 w-full" />
          <Skeleton className="h-2.5 w-full" />
        </div>
      ) : !found ? (
        <div className="py-0.5 text-label-4">{t("Keine Protokolle auf diesem PC")}</div>
      ) : (
        ([[t("Heute"), today!], [t("7 Tage"), week!]] as const).map(([label, x]) => (
          <div key={label} className="tabular grid grid-cols-[auto_1fr_auto] items-baseline gap-2 leading-[18px]">
            <span className="min-w-11 text-label-3">{label}</span>
            <span className="text-label-2">{formatTokens(x.tokens)}</span>
            <span className="font-semibold text-label">{formatCost(x)}</span>
          </div>
        ))
      )}
    </div>
  );
}
