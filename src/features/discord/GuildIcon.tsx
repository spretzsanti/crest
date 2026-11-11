import type { DiscordCall } from "../../platform/services";

/** Server icon; initials without one (like Discord itself). */
export function GuildIcon({ call, size }: { call: DiscordCall; size: number }) {
  const name = call.guildName ?? call.channelName;
  // By code point, so an emoji is not cut in half.
  const initials = Array.from(
    name
      .split(/\s+/)
      .map((w) => Array.from(w)[0] ?? "")
      .join(""),
  )
    .slice(0, 3)
    .join("");
  const radius = size * 0.3;
  if (call.guildIcon) return <img src={call.guildIcon} alt="" draggable={false} className="shrink-0 object-cover" style={{ width: size, height: size, borderRadius: radius }} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center bg-fill-3 font-semibold text-label"
      style={{ width: size, height: size, borderRadius: radius, fontSize: size >= 32 ? undefined : 9 }}
    >
      <span className={size >= 32 ? "text-body" : undefined}>{initials}</span>
    </span>
  );
}
