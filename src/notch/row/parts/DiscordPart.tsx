import { MicrophoneSlash, SpeakerSimpleSlash } from "@phosphor-icons/react";
import type { DiscordCall } from "../../../platform/services";
import { Equalizer } from "../../../features/now-playing/Equalizer";
import { GuildIcon } from "../../../features/discord/GuildIcon";




/** Server icon, gap, and a 16 px box for the state. */
export const DISCORD_WIDTH = 20 + 4 + 16;

/** A Discord call: server icon, then a green equalizer while someone talks, or red when you are deafened or muted. */
export function DiscordPart({ call, paused }: { call: DiscordCall; paused: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <GuildIcon call={call} size={20} />
      <span className="flex w-4 items-center justify-center">
        {call.deaf ? (
          <SpeakerSimpleSlash size={15} weight="fill" className="text-red" />
        ) : call.mute ? (
          <MicrophoneSlash size={15} weight="fill" className="text-red" />
        ) : (
          <Equalizer playing={!paused && (call.speaking || call.members.some((m) => m.speaking))} tint="bg-green" levels={false} />
        )}
      </span>
    </span>
  );
}
