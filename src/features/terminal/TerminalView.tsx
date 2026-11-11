import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, Trash } from "@phosphor-icons/react";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { nav } from "../../notch/nav";
import { keyboardFocus } from "../../platform/native";
import { settings } from "../../settings/store";
import { t } from "../../i18n";
import {
  clearTerminalOutput,
  endSession,
  registerFocusHandler,
  send,
  sessionState,
  start,
  terminalOutput,
  unregisterFocusHandler,
} from "./session";

/**
 * Sleek lightweight native command terminal for Crest.
 * Directly streams output from ConPTY without heavy @xterm/xterm bundle.
 */
export function TerminalView() {
  const output = terminalOutput.use();
  const state = sessionState.use();
  const fontSize = settings.use().terminal.fontSize;
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    registerFocusHandler(() => inputRef.current?.focus());
    if (sessionState.get() === "idle") {
      void start();
    }
    inputRef.current?.focus();

    return () => {
      unregisterFocusHandler();
      if (settings.get().terminal.endOnClose && nav.get().tabId === "terminal") {
        endSession();
      }
    };
  }, []);

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (state === "exited") {
      void start();
      setInput("");
      return;
    }
    const cmd = input;
    setInput("");
    setHistoryIndex(-1);
    if (cmd.trim()) {
      setHistory((prev) => [...prev, cmd]);
    }
    void send(cmd + "\r\n");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInput(history[nextIndex] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex] ?? "");
      }
    }
  };

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <HeaderActions>
        <HeaderButton label={t("Löschen")} onClick={() => clearTerminalOutput()}>
          <Trash size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton
          label={t("Neue Sitzung")}
          onClick={() => {
            void start();
            inputRef.current?.focus();
          }}
        >
          <ArrowClockwise size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>

      <div
        dir="ltr"
        className="flex min-h-0 flex-1 flex-col rounded-[12px] bg-[#1c1c1e] p-3 font-mono border border-white/5 shadow-inner"
        style={{ fontSize: `${fontSize}px` }}
        onPointerDown={() => {
          keyboardFocus(true);
          inputRef.current?.focus();
        }}
      >
        {/* Terminal Output Scroll Area */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed text-white/90 selection:bg-white/20 select-text font-mono"
          style={{ fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace' }}
        >
          {output}
          {state === "starting" && <div className="text-white/40 italic">{t("Startet...")}</div>}
        </div>

        {/* Command Line Input */}
        <form onSubmit={handleSubmit} className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2">
          <span className="text-accent font-semibold select-none">PS &gt;</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={state === "exited" ? t("Enter startet eine neue Sitzung...") : ""}
            className="flex-1 bg-transparent text-white outline-none placeholder:text-white/30"
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </form>
      </div>
    </div>
  );
}
