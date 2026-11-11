import { AnimatePresence, motion } from "motion/react";
import { Headphones, Microphone, MicrophoneSlash, PhoneDisconnect, SlidersHorizontal, SpeakerSimpleSlash, type Icon } from "@phosphor-icons/react";
import { DiscordLogo } from "../../ui/brands";
import { content, springs } from "../../design/motion";
import { t, tBackend } from "../../i18n";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { discord, mockDiscord, type DiscordCall } from "../../platform/services";
import { demo } from "../../dev/showcase-data";
import { Button, Empty } from "../../ui/controls";
import { discordState } from "./store";

const statusText: Record<string, string> = {
  off: "Discord ist aus",
  "no-config": "Client-ID und Secret fehlen",
  "no-client": "Discord läuft nicht",
  connecting: "Verbinde mit Discord …",
  authorizing: "In Discord bestätigen",
  error: "Verbindung fehlgeschlagen",
};

/*
 *   ┌────────────────────────────────────────────────────────┐
 *   │ [▣]  Gaming                                             │
 *   │      The Crew                                           │
 *   │  (◉) (◉) (○) (◉)                                        │
 *   │                         [ 🎙 ]  [ 🎧 ]   [ ☎ Hang up ]  │
 *   └────────────────────────────────────────────────────────┘
 * Like the Dynamic Island call menu: who/where on top, the people in the channel below
 * (green ring = speaking), large round buttons at the bottom. Hang up is red.
 */
export function DiscordView() {
  const s = discordState.use();
  const call = s.call;

  const actions = (
    <HeaderActions>
      <HeaderButton label={t("Discord einrichten")} onClick={() => navigate("settings", "discord")}>
        <SlidersHorizontal size={14} weight="bold" />
      </HeaderButton>
    </HeaderActions>
  );

  if (!call) {
    const ready = s.status === "ready";
    return (
      <>
        {actions}
        <Empty
          icon={DiscordLogo}
          title={ready ? t("Kein Anruf") : t(statusText[s.status] ?? statusText.error)}
          text={
            ready
              ? t("Sobald du einem Sprachkanal beitrittst, erscheint er hier.")
              : s.status === "authorizing"
                ? t("Discord fragt einmal nach, ob die Notch deinen Sprachstatus sehen darf.")
                : s.error ? tBackend(s.error) : undefined
          }
          action={
            s.status === "no-config" ? (
              <Button onClick={() => navigate("settings", "discord")}>{t("Einrichten")}</Button>
            ) : demo && ready ? (
              // Demo only: there is no Discord to join a call in, so a sample one starts here.
              <Button onClick={() => mockDiscord.toggleCall()}>{t("Beispielanruf starten")}</Button>
            ) : undefined
          }
        />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col px-5 pt-1 pb-3">
      {actions}
      <motion.div className="flex items-center gap-3" initial={{ opacity: 0, transform: "translateY(4px)" }} animate={{ opacity: 1, transform: "translateY(0px)" }} transition={content.enter}>
        <GuildIcon call={call} size={44} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-title font-semibold">{call.channelName}</div>
          <div className="truncate text-footnote text-label-2">{call.guildName ?? t("Privater Anruf")}</div>
        </div>
      </motion.div>

      <div className="mt-auto flex items-end justify-between gap-4">
        <Members call={call} />
        <div className="flex shrink-0 items-center gap-2.5">
          <RoundButton
            label={call.mute ? t("Mikrofon an") : t("Stummschalten")}
            icon={call.mute ? MicrophoneSlash : Microphone}
            active={call.mute}
            onClick={() => discord.action("mute")}
          />
          <RoundButton
            label={call.deaf ? t("Ton an") : t("Ton aus")}
            icon={call.deaf ? SpeakerSimpleSlash : Headphones}
            active={call.deaf}
            onClick={() => discord.action("deafen")}
          />
          <RoundButton label={t("Auflegen")} icon={PhoneDisconnect} danger onClick={() => discord.action("leave")} />
        </div>
      </div>
    </div>
  );
}

import { GuildIcon } from "./GuildIcon";
export { GuildIcon };



/** Up to 6 avatars, green ring while speaking; the rest as "+n". */
function Members({ call }: { call: DiscordCall }) {
  const shown = call.members.slice(0, 6);
  const rest = call.members.length - shown.length;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {shown.map((m, i) => (
        <motion.div
          key={m.id}
          className="relative"
          title={m.name}
          initial={{ opacity: 0, transform: "scale(0.9)" }}
          animate={{ opacity: 1, transform: "scale(1)" }}
          transition={{ ...content.enter, delay: 0.04 * i }}
        >
          <img
            src={m.avatar}
            alt={m.name}
            draggable={false}
            className={`size-8 rounded-full object-cover transition-[box-shadow,opacity] duration-200 ${m.muted ? "opacity-50" : ""}`}
            style={{ boxShadow: m.speaking ? "0 0 0 2px var(--color-notch), 0 0 0 4px var(--color-green)" : "0 0 0 2px var(--color-notch)" }}
          />
          <AnimatePresence>
            {m.muted && (
              <motion.span
                className="absolute -end-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full bg-notch"
                initial={{ opacity: 0, transform: "scale(0.9)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.9)" }}
                transition={springs.snappy}
              >
                <MicrophoneSlash size={9} weight="fill" className="text-red" />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>
      ))}
      {rest > 0 && <span className="ms-0.5 text-caption font-medium text-label-3">+{rest}</span>}
    </div>
  );
}

function RoundButton(props: { label: string; icon: Icon; onClick: () => void; active?: boolean; danger?: boolean }) {
  const I = props.icon;
  const tone = props.danger ? "bg-red text-label" : props.active ? "bg-label text-notch" : "pressable-fill bg-fill-2 text-label";
  return (
    <button aria-label={props.label} title={props.label} onClick={props.onClick} className={`pressable flex size-11 items-center justify-center rounded-full ${tone}`}>
      <I size={20} weight="fill" />
    </button>
  );
}
