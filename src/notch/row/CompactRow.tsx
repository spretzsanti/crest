import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
import { content, fade, springs } from "../../design/motion";
import { useNowPlaying } from "../../platform/media";
import { settings } from "../../settings/store";
import { LiveArtwork } from "../../features/now-playing/LiveActivity";
import { LIVE_LYRIC_MAX, LiveLyric } from "../../features/now-playing/LiveLyric";
import { useLyricLine } from "../../features/now-playing/lyrics";
import { Equalizer, RELEASE_CAPTURE_MS } from "../../features/now-playing/Equalizer";
import { timer } from "../../features/timer/store";
import { useDiscordCall } from "../../features/discord/store";
import { useGamingLive } from "../../features/system/gaming";
import { usage } from "../../features/usage/store";
import { Dots, dotsWidth, usePrivacyDots } from "../../features/privacy/PrivacyDots";
import { naturalWidth, planVisible, type PlacedPart, type RowItem } from "./layout";
import { partTool, trackCaption } from "./parts";
import { useRowVisible } from "./visibility";
import { fontEpoch, measureText } from "./measure";
import { Carousel } from "./Carousel";
import { Marquee } from "./Marquee";
import { RING, RING_GAP, Ring, ringLabel, ringProviders, ringValue } from "./parts/Rings";
import { READING_GAP, ReadingView, readingWidth, useReadings } from "./parts/Readings";
import { Clock, clockWidth } from "./parts/Clock";
import { TimerPart, timerWidth } from "./parts/TimerPart";
import { DISCORD_WIDTH, DiscordPart } from "./parts/DiscordPart";
import { GithubPart, githubWidth, useGithubToday } from "./parts/GithubPart";
import { WeatherPart, useWeatherNow, weatherWidth } from "./parts/WeatherPart";
import { NextEventPart, nextEventWidth, useNextEvent } from "./parts/NextEventPart";
import { ScriptParts, scriptPartsWidth } from "./parts/ScriptPart";
import { scriptParts } from "../../features/notices/store";
import { Coffee } from "@phosphor-icons/react";
import { t } from "../../i18n";
import { awake } from "../../features/overview/store";
import { DownloadsPart, downloadsCaption, downloadsWidth } from "./parts/DownloadsPart";
import { downloads } from "../../features/downloads/store";

/** True while `on`, and for `ms` after it turns off: GSMTC reports a short pause on seek and track change. */
export function useHeld(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(on);
  useEffect(() => {
    if (on) return setHeld(true);
    const id = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(id);
  }, [on, ms]);
  return on || held;
}

/** The line the row last showed, kept across the remount that comes with each close. */
let lastLine: { song: string; line: string | null } | null = null;

/** The lyrics take a moment to come back after a remount; for that moment the row keeps the line it had, instead of showing the title and then jumping to the line. */
function useRememberedLyric(np: { title?: string; artist?: string } | null, live: string | null): string | null {
  const song = np ? `${np.title}\n${np.artist}` : "";
  const [warm, setWarm] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setWarm(false), 800);
    return () => window.clearTimeout(id);
  }, []);
  const held = warm && live === null && lastLine?.song === song ? lastLine.line : null;
  useEffect(() => {
    if (live !== null || !warm) lastLine = { song, line: live };
  }, [song, live, warm]);
  return live ?? held;
}

/**
 * The closed notch's content: the chosen parts side by side, centred, in the order from the settings, with the cover first
 * and the privacy dots last. Widths are fixed or measured, never read back from layout, so changing digits never move a
 * neighbour. Reports its content width; the shape is that plus its insets. Mounted only while the row is on screen
 * (closed or peeking, not the line, not focus, not hidden for fullscreen), so its audio, timers and polling stop with it.
 * Laid out at its designed size and drawn `scale` times as big (Notch.tsx): `room` is the widest it gets at that size.
 */
export function CompactRow({ room, scale, covered, onWidth }: { room: number; scale: number; covered: boolean; onWidth: (content: number) => void }) {
  useRowVisible();
  fontEpoch.use();
  const s = settings.use(), closed = s.closed;
  const np = useNowPlaying();
  const playing = useHeld(!!np?.isPlaying, RELEASE_CAPTURE_MS);
  const running = timer.use().endsAt !== null;
  const call = useDiscordCall();
  const rings = ringProviders(usage.use().providers);
  const readings = useReadings(closed, useGamingLive());
  const dots = usePrivacyDots();
  const awakeOn = !!awake.use();
  const gh = useGithubToday();
  const weather = useWeatherNow(closed.parts.weather);
  const next = useNextEvent();
  const scripted = scriptParts.use();
  const dl = downloads.use();
  const [hovered, setHovered] = useState(false);
  // The title stays while paused, like the cover; it only scrolls while playing.
  const music = s.music;
  const lyric = useRememberedLyric(np, useLyricLine(np, (closed.parts.title && music.titleLyrics) || music.notchLyrics, { roman: music.closedRoman === true, translation: music.closedTranslation === true }));
  // Lyric mode of the title part: the current line, the title before the first line, in gaps and without lyrics.
  const titleLyric = music.titleLyrics && lyric;
  const caption = titleLyric ? lyric : np ? trackCaption(np.title ?? "", np.artist ?? "") : "";
  // Lyrics in the closed notch: while a line is sung, cover and line (with a running timer or a Discord call) replace the row,
  // which grows and shrinks with each line.
  const lyricOnly = music.notchLyrics && lyric && np?.isPlaying ? lyric : null;

  const parts: { item: RowItem; draw: (p: PlacedPart) => ReactNode }[] = [];
  const fixed = (id: string, width: number, draw: () => ReactNode) => parts.push({ item: { id, kind: "fixed", width }, draw });
  if (np) fixed("cover", 20, () => <LiveArtwork artwork={np.artwork} />);
  if (lyricOnly) {
    const text = measureText(lyricOnly);
    fixed("lyric", Math.min(text, LIVE_LYRIC_MAX), () => <LiveLyric text={lyricOnly} textWidth={text} width={Math.min(text, LIVE_LYRIC_MAX)} paused={hovered || covered} />);
  }
  for (const id of closed.order) {
    if (!closed.parts[id] && id !== "readings") continue;
    // A running timer and a Discord call stay next to the line; they only show while active anyway.
    if (lyricOnly && id !== "timer" && id !== "discord") continue;
    if (id === "timer" && running) fixed(id, timerWidth(timer.get().duration, timer.get().linkedTask?.title), () => <TimerPart paused={covered} />);
    else if (id === "discord" && call) fixed(id, DISCORD_WIDTH, () => <DiscordPart call={call} paused={covered} />);
    else if (id === "equalizer" && np && playing) fixed(id, 16, () => <Equalizer playing={np.isPlaying && !covered} />);
    else if (id === "github" && gh) fixed(id, githubWidth(gh.count), () => <GithubPart count={gh.count} level={gh.level} />);
    else if (id === "weather" && weather) fixed(id, weatherWidth(), () => <WeatherPart now={weather} />);
    else if (id === "calendar" && next) fixed(id, nextEventWidth(next.text, !!next.link), () => <NextEventPart text={next.text} color={next.color} link={next.link} eventId={next.event.id} />);
    else if (id === "script" && scripted.length) fixed(id, scriptPartsWidth(scripted), () => <ScriptParts parts={scripted} />);
    else if (id === "downloads" && dl.length) {
      const caption = downloadsCaption(dl);
      fixed(id, downloadsWidth(caption), () => <DownloadsPart list={dl} caption={caption} />);
    }
    else if (id === "clock") fixed(id, clockWidth(closed.clockSeconds, s.units.clock === "12"), () => <Clock seconds={closed.clockSeconds} h12={s.units.clock === "12"} paused={covered} />);
    else if (id === "title" && caption) {
      const text = measureText(caption);
      parts.push({ item: { id, kind: "title", text }, draw: (p) => titleLyric
        ? <LiveLyric text={caption} textWidth={text} width={p.width} paused={hovered || covered} />
        : <Marquee key={caption} text={caption} textWidth={text} width={p.width} paused={hovered || covered || !np?.isPlaying} /> });
    } else if (id === "rings" && rings.length) {
      parts.push({
        item: { id, kind: "carousel", items: rings.map(() => RING), gap: RING_GAP },
        draw: (p) => <Carousel items={rings.map((r) => <Ring key={r.id} id={r.id} value={ringValue(r)} label={ringLabel(r)} />)} gap={RING_GAP} window={p.window!} width={p.width} paused={hovered || covered} />,
      });
    } else if (id === "readings" && readings.length) {
      // useReadings already leaves the part out when it is off and gaming is not forcing it on.
      parts.push({
        item: { id, kind: "carousel", items: readings.map((r) => readingWidth(r.id)), gap: READING_GAP },
        draw: (p) => <Carousel items={readings.map((r) => <ReadingView key={r.id} reading={r} />)} gap={READING_GAP} window={p.window!} width={p.width} paused={hovered || covered} />,
      });
    }
  }
  if (awakeOn) fixed("awake", 13, () => <Coffee size={13} weight="fill" className="text-label-2" aria-label={t("PC bleibt wach")} />);
  if (dots.length) fixed("privacy", dotsWidth(dots.length), () => <Dots dots={dots} />);

  const items = parts.map((p) => p.item);
  // Device pixels per px of the row as drawn; an even number of them, so the centred row starts on a whole one.
  const dpi = (window.devicePixelRatio || 1) * scale;
  const width = Math.min(room, (Math.ceil((naturalWidth(items) * dpi) / 2 - 1e-9) * 2) / dpi);
  const plan = planVisible(items, width, dpi);
  useLayoutEffect(() => onWidth(width), [width, onWidth]);

  // Choosing other parts fades the whole row over; parts coming and going while it stays the same grow and shrink.
  const chosen = `${closed.order.filter((id) => closed.parts[id]).join()}|${Object.values(closed.readings).join()}|${closed.clockSeconds}`;
  return (
    <motion.div
      // Faded out under a notice: no longer a target for a click or a hover (Notch.tsx partTarget).
      data-covered={covered ? "" : undefined}
      className="absolute top-0 left-1/2 h-[30px]"
      style={{ width, marginLeft: -width / 2 }}
      initial={{ opacity: 0 }}
      // Under a notice the row only fades out: it stays mounted, so its polling goes on, but its cycles, clock and equalizers rest.
      animate={covered ? { opacity: 0, transition: content.exit } : { opacity: 1, transition: content.enter }}
      exit={{ opacity: 0, transition: content.exit }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <AnimatePresence initial={false}>
        {/* Parts sit at offsets from the centre, which stays put while the row's width changes. */}
        <motion.div key={chosen} className="absolute inset-y-0 left-1/2 w-0" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade }} exit={{ opacity: 0, transition: fade }}>
          <AnimatePresence initial={false}>
            {plan.parts.map((p) => (
              <Slot key={p.id} x={p.left + p.width / 2 - width / 2} width={p.width} tool={partTool(p.id)}>
                {parts.find((x) => x.item.id === p.id)!.draw(p)}
              </Slot>
            ))}
          </AnimatePresence>
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * A part's room. It grows in from 0.82 with the opacity going as the square of its progress, and shrinks out the same way.
 * `x` is its centre: the spring moves that, and the width changes at once around it, so no layout runs per frame.
 * `tool`: the tool a click or a hover over it opens (Notch.tsx reads data-open).
 */
function Slot({ x, width, tool, children }: { x: number; width: number; tool: string | null; children: ReactNode }) {
  const scale = useMotionValue(1);
  const opacity = useTransform(scale, (v) => Math.max(0, (v - 0.82) / 0.18) ** 2);
  return (
    <motion.div
      data-open={tool ?? undefined}
      className="absolute inset-y-0 flex items-center justify-center"
      style={{ scale, opacity, width, marginLeft: -width / 2 }}
      initial={{ scale: 0.82, x }}
      animate={{ scale: 1, x }}
      exit={{ scale: 0.82 }}
      transition={{ ...springs.morph, scale: springs.snappy }}
    >
      {children}
    </motion.div>
  );
}
