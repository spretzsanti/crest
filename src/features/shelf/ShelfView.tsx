import { useEffect, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  Check,
  CheckSquare,
  ClipboardText,
  Copy,
  DeviceMobile,
  File,
  FileAudio,
  FileText,
  FileVideo,
  FolderOpen,
  ImageSquare,
  Table,
  Trash,
  Tray,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { fade, springs } from "../../design/motion";
import { formatBytes } from "../../lib/format";
import { draggingOut, drop, pasteFiles, takeDropped, usePasteFiles } from "../../platform/drop";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { holdOpen } from "../../notch/useNotchState";
import { clipboardText, copyFiles, filePreview, openFile, onPhoneShareLost, phoneShareStart, phoneShareStop, probeFiles, revealFile, shelfDragOut, type FileKind, type PhoneShare } from "../../platform/services";
import { addText, dragPayload, isText, keyOf, removeKeys, type FileItem, type TextItem } from "./model";

import { NONE, clickSelect, dragKeys, prune, type Selection } from "./selection";
import { lang, t, tBackend } from "../../i18n";
import { usePresenting } from "../privacy/store";
import { HUE_PALETTE } from "../themes/themes";
import { Redacted } from "../../ui/controls";

/*
 * Shelf: put files on the notch and later open them with one click, show them in Explorer,
 * paste them elsewhere with Ctrl+V or drag them out into another app. Only references are
 * stored; the files stay where they are. Text cards keep a snippet: click copies it, dragging
 * gives the text.
 *
 * Files come in via drag and drop or Ctrl+V (screenshots too), text via drop on the open
 * shelf or Ctrl+V. Anything dropped on the closed notch lands here.
 *
 * Select several: Ctrl+click, Shift+click or the select button; then drag, copy or remove
 * them together.
 *
 * Send to phone: the picked files (or all of them) behind a QR code, served on the local network
 * until it is stopped, the shelf closes or ten minutes pass (phone_share.rs). The notch stays
 * open meanwhile, so the link does not vanish while the phone is out.
 */
import { shelf, addToShelf } from "./store";
export { addToShelf, shelf };

/** Movement in px before a press on a card becomes a drag. */
const DRAG_START = 6;



/** Thumbnails by file and size: the shelf is rebuilt on every opening, decoding a photo each time is slow. */
const previews = new Map<string, Promise<string | null>>();
const PREVIEWS_AT_ONCE = 2;
let decoding = 0;
const waiting: (() => void)[] = [];

function previewOf(item: FileItem): Promise<string | null> {
  const key = `${item.path}|${item.size}`;
  let p = previews.get(key);
  if (!p) {
    const turn = new Promise<void>((go) => {
      const start = () => {
        decoding++;
        go();
      };
      if (decoding < PREVIEWS_AT_ONCE) start();
      else waiting.push(start);
    });
    p = turn
      .then(() => filePreview(item.path))
      .catch(() => null)
      .finally(() => {
        decoding--;
        waiting.shift()?.();
      });
    previews.set(key, p);
  }
  return p;
}

const kindIcon: Record<FileKind, Icon> = { image: ImageSquare, audio: FileAudio, video: FileVideo, document: FileText, table: Table, other: File };

const newTextId = () => `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function keepText(text: string) {
  shelf.set((list) => addText(list, text, Date.now(), newTextId()));
}

/** Ctrl+V or the paste button: files or an image first, otherwise text becomes a card. */
async function pasteTextFallback(): Promise<boolean> {
  const text = await clipboardText();
  if (!text.trim()) return false;
  keepText(text);
  return true;
}

const isTextDrag = (e: DragEvent) => {
  const types = e.dataTransfer.types;
  return types.includes("text/plain") && !types.includes("Files");
};

export function ShelfView() {
  const items = shelf.use();
  // Shared or recorded screen: text cards show no text, not even to a screen reader's label.
  const presenting = usePresenting();
  const { dragging, dropped } = drop.use();
  const out = draggingOut.use();
  const [copied, setCopied] = useState<string | null>(null);
  const [nothing, setNothing] = useState(false);
  const [textOver, setTextOver] = useState(false);
  const [selecting, setSelecting] = useState(false);
  /** Last drag out or send error (e.g. the files are gone), shown briefly in the header. */
  const [failed, setFailed] = useState<string | null>(null);
  const failTimer = useRef<number | undefined>(undefined);
  const [share, setShare] = useState<(PhoneShare & { paths: string[] }) | null>(null);
  const [rawSel, setSel] = useState<Selection>(NONE);
  const order = items.map(keyOf);
  const sel = prune(rawSel, order);
  const press = useRef<{ x: number; y: number; key: string } | null>(null);
  const swallowClick = useRef(false);

  usePasteFiles(() => void pasteTextFallback().then((ok) => !ok && flash(setNothing)));

  useEffect(() => {
    const paths = takeDropped();
    // A file dragged out and dropped back on the notch is already here and keeps its place.
    if (paths?.length) addToShelf(paths);
  }, [dropped]);

  const fail = (e: unknown, label?: string) => {
    const reason = tBackend(String(e));
    setFailed(label ? `${label}: ${reason}` : reason);
    window.clearTimeout(failTimer.current);
    failTimer.current = window.setTimeout(() => setFailed(null), 4000);
  };

  // A share lives as long as its panel: closing it, a new share or leaving the shelf stops it.
  useEffect(() => {
    if (!share) return;
    holdOpen(true);
    const id = setTimeout(() => setShare(null), share.ttl * 1000);
    return () => {
      clearTimeout(id);
      holdOpen(false);
      phoneShareStop(share.url);
    };
  }, [share]);

  useEffect(() => {
    if (!share) return;
    return onPhoneShareLost((url) => {
      if (url !== share.url) return;
      setShare(null);
      fail(t("Netzwerk gewechselt, bitte neu senden"));
    });
  }, [share]);

  // Nothing shared is left on the shelf (cleared or removed): stop serving it.
  useEffect(() => {
    if (share && !share.paths.some((p) => order.includes(p))) setShare(null);
  }, [items]);

  // Items that left the shelf are forgotten, or putting one back would show it picked.
  useEffect(() => {
    if (sel !== rawSel) setSel(sel);
  }, [sel, rawSel]);

  const sendToPhone = (keys: string[]) => {
    const { paths } = dragPayload(items, keys);
    if (!paths.length) return;
    // Only files that still exist are served, so only those are counted.
    void probeFiles(paths)
      .then(({ files }) => {
        const found = files.map((f) => f.path);
        const n = found.length;
        const text = {
          lang: lang(),
          dir: document.documentElement.dir,
          title: t("Bereit zum Herunterladen"),
          count: n === 1 ? `1 ${t("Datei")}` : t("{n} Dateien", { n }),
          hint: t("Tippe auf eine Datei, um sie zu speichern."),
          footer: t("Direkt von deinem Computer über das WLAN, ohne Cloud."),
        };
        return phoneShareStart(found, text).then((s) => setShare({ ...s, paths: found }));
      })
      .catch((e: unknown) => fail(e, t("Senden fehlgeschlagen")));
  };
  const hasFiles = (keys: string[]) => dragPayload(items, keys).paths.length > 0;

  const flashCopied = (key: string) => {
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
  };

  const copyKeys = async (keys: string[], flashKey: string) => {
    const { paths, text } = dragPayload(items, keys);
    if (paths.length) {
      try {
        await copyFiles(paths);
      } catch (e) {
        return fail(e);
      }
    } else if (text !== null) {
      // A denied clipboard shows no "copied".
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return;
      }
    } else return;
    flashCopied(flashKey);
  };

  const clearSelection = () => {
    setSel(NONE);
    setSelecting(false);
  };

  // Drag out: press, move a few px with the button held, then Windows takes over until the drop.
  const onPointerDown = (e: PointerEvent, key: string) => {
    swallowClick.current = false;
    press.current = e.button === 0 ? { x: e.clientX, y: e.clientY, key } : null;
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || !(e.buttons & 1) || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START) return;
    press.current = null;
    swallowClick.current = true;
    const { paths, text } = dragPayload(items, dragKeys(sel, p.key));
    if (!paths.length && text === null) return;
    draggingOut.set(true);
    void shelfDragOut(paths, text)
      .catch((e: unknown) => fail(e, t("Ziehen fehlgeschlagen")))
      // The drop back on the notch reaches the page a moment after the drag ends.
      .finally(() => setTimeout(() => draggingOut.set(false), 500));
  };

  // Modifier clicks and select mode pick cards instead of opening or copying them.
  const onClickCapture = (e: MouseEvent, key: string) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      e.stopPropagation();
      return;
    }
    const toggle = e.ctrlKey || e.metaKey || selecting;
    if ((!toggle && !e.shiftKey) || (e.target as Element).closest("[data-remove]")) return;
    e.stopPropagation();
    e.preventDefault();
    setSel(clickSelect(sel, order, key, { toggle, range: e.shiftKey }));
  };

  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!isTextDrag(e) || draggingOut.get()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setTextOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTextOver(false);
    },
    onDrop: (e: DragEvent) => {
      setTextOver(false);
      if (!isTextDrag(e) || draggingOut.get()) return;
      e.preventDefault();
      keepText(e.dataTransfer.getData("text/plain"));
    },
  };

  const over = (dragging || textOver) && !out;

  if (items.length === 0) {
    return (
      <div className="h-full px-4 pt-1 pb-2" {...dropHandlers}>
        <motion.div
          className={`flex h-full flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed transition-colors duration-200 ${
            over ? "border-label-2 bg-fill-2" : "border-fill-3 bg-fill-1"
          }`}
          animate={{ transform: over ? "scale(1.015)" : "scale(1)" }}
          transition={springs.snappy}
        >
          <Tray size={22} weight="bold" className={over ? "text-label" : "text-label-3"} />
          <span className="text-body text-label-2">{over ? t("Loslassen zum Ablegen") : t("Dateien oder Text hierher ziehen")}</span>
          <PasteHint nothing={nothing} onPaste={() => void pasteAny().then((ok) => !ok && flash(setNothing))} />
        </motion.div>
      </div>
    );
  }

  const picked = sel.keys.length;

  return (
    <div className="relative flex h-full flex-col px-4 pt-1 pb-2" {...dropHandlers}>
      <HeaderActions>
        {failed !== null && (
          <span role="alert" title={failed} className="me-1 max-w-52 truncate text-caption text-red">
            {failed}
          </span>
        )}
        {picked > 0 ? (
          <>
            <span className="tabular me-1 text-caption text-label-2">{t("{n} ausgewählt", { n: picked })}</span>
            <HeaderButton label={copied === "picked" ? t("Kopiert") : t("Auswahl kopieren")} onClick={() => void copyKeys(sel.keys, "picked")}>
              {copied === "picked" ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
            </HeaderButton>
            {hasFiles(sel.keys) && (
              <PhoneButton onClick={() => sendToPhone(sel.keys)} />
            )}
            <HeaderButton label={t("Auswahl entfernen")} onClick={() => shelf.set((l) => removeKeys(l, sel.keys))}>
              <Trash size={14} weight="bold" />
            </HeaderButton>
            <HeaderButton label={t("Auswahl aufheben")} onClick={clearSelection}>
              <X size={14} weight="bold" />
            </HeaderButton>
          </>
        ) : (
          <>
            <span className="tabular me-1 text-caption text-label-3">
              {items.length} {items.length === 1 ? t("Eintrag") : t("Einträge")}
            </span>
            <HeaderButton label={selecting ? t("Auswählen beenden") : t("Auswählen")} active={selecting} onClick={() => (selecting ? clearSelection() : setSelecting(true))}>
              <CheckSquare size={14} weight="bold" />
            </HeaderButton>
            <HeaderButton label={copied === "all" ? t("Kopiert") : t("Alle kopieren")} onClick={() => void copyKeys(order, "all")}>
              {copied === "all" ? <Check size={14} weight="bold" /> : <Copy size={14} weight="bold" />}
            </HeaderButton>
            {hasFiles(order) && (
              <PhoneButton onClick={() => sendToPhone(order)} />
            )}
            <HeaderButton label={t("Ablage leeren")} onClick={() => shelf.set([])}>
              <Trash size={14} weight="bold" />
            </HeaderButton>
          </>
        )}
      </HeaderActions>
      <div role="listbox" aria-multiselectable="true" aria-label={t("Ablage")} className="flex min-h-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none]">
        <AnimatePresence initial={false} mode="popLayout">
          {items.map((item) => {
            const key = keyOf(item);
            const on = sel.keys.includes(key);
            return (
              <motion.div
                key={key}
                layout
                transition={springs.snappy}
                initial={{ opacity: 0, transform: "scale(0.94)" }}
                animate={{ opacity: 1, transform: "scale(1)" }}
                exit={{ opacity: 0, transform: "scale(0.94)", transition: fade }}
                className="group relative h-full w-[112px] shrink-0"
                onPointerDown={(e) => onPointerDown(e, key)}
                onPointerMove={onPointerMove}
                onPointerUp={() => (press.current = null)}
                onClickCapture={(e) => onClickCapture(e, key)}
                role="option"
                aria-selected={on}
                aria-label={isText(item) ? (presenting ? t("Text") : item.text.slice(0, 80)) : presenting ? t("Datei") : item.name}
              >
                {isText(item) ? (
                  <TextCard item={item} hidden={presenting} copied={copied === key} onCopy={() => void copyKeys([key], key)} />
                ) : (
                  <FileCard item={item} copied={copied === key} onCopy={() => void copyKeys([key], key)} onFail={fail} />
                )}
                <span
                  className={`pointer-events-none absolute inset-0 rounded-[14px] ring-2 transition-opacity duration-150 ring-inset ${
                    on ? "opacity-100 ring-label-2" : "opacity-0 ring-transparent"
                  }`}
                />
                {(selecting || picked > 0) && (
                  <span
                    className={`pointer-events-none absolute top-1.5 start-1.5 flex size-5 items-center justify-center rounded-full backdrop-blur-md ${
                      on ? "bg-label text-notch" : "bg-fill-3 text-transparent"
                    }`}
                  >
                    <Check size={10} weight="bold" />
                  </span>
                )}
                <button
                  data-remove
                  aria-label={t("Entfernen")}
                  onClick={() => shelf.set((l) => removeKeys(l, [key]))}
                  className="pressable absolute top-1.5 end-1.5 flex size-5 items-center justify-center rounded-full bg-fill-3 text-label-2 opacity-0 backdrop-blur-md group-hover:opacity-100 focus-visible:opacity-100 hover:text-label"
                >
                  <X size={10} weight="bold" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <AnimatePresence>{share && <PhonePanel share={share} onStop={() => setShare(null)} />}</AnimatePresence>
      <AnimatePresence>
        {over && (
          <motion.div
            className="pointer-events-none absolute inset-x-4 top-1 bottom-3 flex items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-label-2 bg-black/70 text-body text-label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
          >
            {t("Loslassen zum Ablegen")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Send to phone, in the shelf's own colour and with its name: the one action here worth finding at a glance. */
function PhoneButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="pressable me-1 flex h-7 items-center gap-1.5 rounded-full px-3 text-caption font-semibold text-[#000] transition-opacity duration-150 hover:opacity-85"
      style={{ background: HUE_PALETTE.amber[0] }}
    >
      <DeviceMobile size={14} weight="bold" />
      {t("Aufs Handy senden")}
    </button>
  );
}

/** The QR to scan with the phone, over the cards. Hidden while the screen is shared: anyone watching could scan it. */
function PhonePanel({ share, onStop }: { share: PhoneShare & { paths: string[] }; onStop: () => void }) {
  const hidden = usePresenting();
  return (
    <motion.div
      className="absolute inset-x-4 top-1 bottom-2 z-10 flex items-center gap-4 rounded-[14px] bg-notch p-3 ring-1 ring-fill-2 ring-inset"
      initial={{ opacity: 0, transform: "scale(0.97)" }}
      animate={{ opacity: 1, transform: "scale(1)" }}
      exit={{ opacity: 0, transform: "scale(0.99)", transition: fade }}
      transition={springs.snappy}
    >
      {hidden ? (
        <div className="grid h-full max-h-[150px] shrink-0 aspect-square place-items-center rounded-[10px] bg-fill-2 p-3 text-center text-caption text-label-3">{t("Im Präsentationsmodus ausgeblendet")}</div>
      ) : (
        <svg viewBox={`0 0 ${share.size} ${share.size}`} shapeRendering="crispEdges" role="img" aria-label={t("QR-Code")} className="h-full max-h-[150px] shrink-0 aspect-square rounded-[10px] bg-white">
          <path d={share.qr} fill="#000" />
        </svg>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body font-semibold text-label">{t("Mit dem Handy scannen")}</p>
        <p className="text-caption text-label-2">{share.paths.length === 1 ? `1 ${t("Datei")}` : t("{n} Dateien", { n: share.paths.length })}</p>
        <p className="text-caption text-label-3">{t("Handy und Computer müssen im selben WLAN sein. Endet nach {n} Minuten.", { n: Math.round(share.ttl / 60) })}</p>
        <p className="text-caption text-label-3">{t("Klappt es nicht? VPN, Firewall oder Gast-WLAN prüfen.")}</p>
        {!hidden && <p className="truncate text-caption text-label-3 tabular" title={share.url}>{share.url.replace(/^http:\/\//, "") || t("Nur in der App")}</p>}
        <button onClick={onStop} className="pressable mt-1 self-start rounded-full bg-fill-2 px-3 py-1 text-caption font-medium text-label hover:bg-fill-3">
          {t("Stopp")}
        </button>
      </div>
    </motion.div>
  );
}

async function pasteAny(): Promise<boolean> {
  return (await pasteFiles()) || (await pasteTextFallback());
}

function FileCard({ item, copied, onCopy, onFail }: { item: FileItem; copied: boolean; onCopy: () => void; onFail: (e: unknown) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const I = kindIcon[item.kind];
  const hidden = usePresenting();
  const open = () => void openFile(item.path).catch(onFail);
  // A file name can be private: not while presenting.
  const name = hidden ? t("Datei") : item.name;
  // Not while presenting: the picture isn't shown then.
  useEffect(() => {
    if (item.kind === "image" && !hidden) void previewOf(item).then(setPreview);
  }, [item.path, item.kind, hidden]);

  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-[14px] bg-fill-1">
      <button
        onClick={open}
        title={t("{name} öffnen", { name })}
        className="pressable relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        {preview && !hidden ? (
          <img src={preview} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
        ) : (
          <I size={30} weight="duotone" className="text-label-2" />
        )}
      </button>
      <div className="px-2 pt-1.5 pb-1">
        <p className="truncate text-caption font-medium text-label" title={name}>{name}</p>
        <div className="flex items-center justify-between">
          <span className="tabular text-caption text-label-3">{formatBytes(item.size, 0)}</span>
          <span className="flex opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
            <IconBtn label={t("Im Explorer zeigen")} icon={FolderOpen} onClick={() => void revealFile(item.path).catch(onFail)} />
            <IconBtn label={copied ? t("Kopiert") : t("Kopieren")} icon={copied ? Check : Copy} onClick={onCopy} />
            <IconBtn label={t("Öffnen")} icon={ArrowSquareOut} onClick={open} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** A kept snippet: click copies it, dragging it out gives the text. */
function TextCard({ item, hidden, copied, onCopy }: { item: TextItem; hidden: boolean; copied: boolean; onCopy: () => void }) {
  return (
    <div className="relative flex size-full flex-col overflow-hidden rounded-[14px] bg-fill-1">
      <button onClick={onCopy} title={t("Klicken zum Kopieren")} className="pressable flex min-h-0 flex-1 items-start overflow-hidden px-2.5 pt-2.5 text-start">
        {hidden ? <Redacted lines={4} /> : <p className="line-clamp-6 text-caption break-words whitespace-pre-wrap text-label-2">{item.text}</p>}
      </button>
      <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
        <span className="tabular min-w-0 truncate text-caption text-label-3">{item.text.length === 1 ? t("1 Zeichen") : t("{n} Zeichen", { n: item.text.length })}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={copied ? "done" : "copy"}
            className={`flex ${copied ? "text-green" : "text-label-3 opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
            initial={{ opacity: 0, transform: "scale(0.6)" }}
            animate={{ opacity: 1, transform: "scale(1)" }}
            exit={{ opacity: 0, transform: "scale(0.6)" }}
            transition={fade}
          >
            {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Second path besides drag and drop, visible because Ctrl+V isn't discoverable. */
export function PasteHint({ nothing, onPaste }: { nothing: boolean; onPaste?: () => void }) {
  return (
    <button onClick={onPaste ?? (() => void pasteFiles())} className="pressable flex items-center gap-1 text-caption text-label-3 hover:text-label-2">
      <ClipboardText size={12} weight="bold" />
      {nothing ? t("Keine Dateien in der Zwischenablage") : t("oder Strg+V zum Einfügen")}
    </button>
  );
}

function flash(set: (v: boolean) => void) {
  set(true);
  setTimeout(() => set(false), 1600);
}

function IconBtn({ label, icon: I, onClick }: { label: string; icon: Icon; onClick: () => void }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="pressable flex size-5 items-center justify-center text-label-3 hover:text-label">
      <I size={12} weight="bold" />
    </button>
  );
}
