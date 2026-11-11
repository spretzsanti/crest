import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowBendDownLeft,
  CalendarBlank,
  Calculator,
  CheckCircle,
  File,
  FilePdf,
  Folder,
  MagnifyingGlass,
  RocketLaunch,
  X,
} from "@phosphor-icons/react";
import { omnisearch, revealFile, type OmniResult } from "../../platform/services";
import { addToShelf } from "../shelf/store";
import { todoActions } from "../todos/store";
import { quickCreateEvent } from "../calendar/store";
import { closeNotch } from "../../notch/useNotchState";
import { t } from "../../i18n";

type PrefixMode = "" | "t" | "c" | "p";

const PREFIX_CHIPS: { id: PrefixMode; label: string; placeholder: string }[] = [
  { id: "", label: "Todo", placeholder: "Buscar apps, archivos, fórmulas (1/(2*pi*10k*100n)), unidades (10k, 100n)..." },
  { id: "t", label: "t Tareas", placeholder: "Crear tarea en Google Tasks: ej. Estudiar unidad 10..." },
  { id: "c", label: "c Eventos", placeholder: "Crear evento en Google Calendar: ej. Parcial viernes 14:00..." },
  { id: "p", label: "p PDFs", placeholder: "Buscar dentro de PDFs y apuntes de la Facultad..." },
];

export function OmniSearchView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OmniResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Parse active prefix mode
  const { prefix, cleanQuery } = useMemo(() => {
    const trimmed = query.trimStart();
    if (trimmed.startsWith("t ") || trimmed.startsWith("t:")) {
      return { prefix: "t" as PrefixMode, cleanQuery: trimmed.slice(2).trimStart() };
    }
    if (trimmed.startsWith("c ") || trimmed.startsWith("c:")) {
      return { prefix: "c" as PrefixMode, cleanQuery: trimmed.slice(2).trimStart() };
    }
    if (trimmed.startsWith("p ") || trimmed.startsWith("p:")) {
      return { prefix: "p" as PrefixMode, cleanQuery: trimmed.slice(2).trimStart() };
    }
    return { prefix: "" as PrefixMode, cleanQuery: query };
  }, [query]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
    void omnisearch.status().then(setStatusText);
  }, []);

  // Search query debounce
  useEffect(() => {
    let active = true;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSelectedIndex(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(() => {
      omnisearch
        .query(query, prefix ? prefix : null)
        .then((res) => {
          if (active) {
            setResults(res);
            setSelectedIndex(0);
            setLoading(false);
          }
        })
        .catch(() => {
          if (active) setLoading(false);
        });
    }, 40);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, prefix]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll<HTMLElement>("[data-omni-item]");
    const activeItem = items[selectedIndex];
    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const selectPrefix = (mode: PrefixMode) => {
    if (mode === "") {
      setQuery(cleanQuery);
    } else {
      setQuery(`${mode} ${cleanQuery}`);
    }
    inputRef.current?.focus();
  };

  const handleOpen = async (item: OmniResult) => {
    if (item.category === "action") {
      if (item.target.startsWith("action:task:")) {
        const text = item.action_data || item.target.replace("action:task:", "");
        todoActions.add(text);
        showFeedback(t("Tarea creada"));
        setTimeout(closeNotch, 400);
        return;
      }
      if (item.target.startsWith("action:calendar:")) {
        const text = item.action_data || item.target.replace("action:calendar:", "");
        const now = new Date();
        const start = new Date(now.getTime() + 3600_000);
        const end = new Date(now.getTime() + 7200_000);
        try {
          await quickCreateEvent(text, start, end);
          showFeedback(t("Evento agendado en Google Calendar"));
        } catch {
          await omnisearch.open(item.target, "open");
        }
        setTimeout(closeNotch, 500);
        return;
      }
    }

    if (item.category === "calc") {
      const val = item.action_data || item.target.replace("calc:", "");
      void navigator.clipboard.writeText(val);
      showFeedback(t("Resultado copiado: {val}", { val }));
      setTimeout(closeNotch, 500);
      return;
    }

    await omnisearch.open(item.target, "open");
    closeNotch();
  };

  const handleReveal = async (item: OmniResult) => {
    if (item.category === "calc" || item.category === "action") return;
    await revealFile(item.target);
    showFeedback(t("Mostrando en el Explorador"));
  };

  const handleShelf = (item: OmniResult) => {
    if (item.category === "calc" || item.category === "action") return;
    addToShelf([item.target]);
    showFeedback(t("Enviado al Shelf"));
  };

  const showFeedback = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 1500);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % results.length);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const current = results[selectedIndex];
      if (e.ctrlKey) {
        if (current) void handleReveal(current);
      } else if (e.shiftKey) {
        if (current) handleShelf(current);
      } else {
        if (current) void handleOpen(current);
      }
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const trimmed = query.trim();
      if (trimmed === "t" || trimmed === "c" || trimmed === "p") {
        setQuery(`${trimmed} `);
        return;
      }
      const current = results[selectedIndex];
      if (current) {
        setQuery(current.title);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
      } else {
        closeNotch();
      }
      return;
    }
  };

  const activePlaceholder = useMemo(() => {
    const chip = PREFIX_CHIPS.find((c) => c.id === prefix);
    return chip ? chip.placeholder : PREFIX_CHIPS[0].placeholder;
  }, [prefix]);

  return (
    <div className="flex flex-col h-full w-full select-none text-[var(--color-text)]">
      {/* Search Header Bar */}
      <div className="flex items-center px-4 py-3 gap-3 border-b border-[var(--color-border)] bg-[var(--color-fill-1)]/40">
        <MagnifyingGlass size={20} className="text-[var(--color-dim)] shrink-0" weight="bold" />
        
        {/* Prefix tag badge if active */}
        {prefix && (
          <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wider bg-[var(--color-tint)] text-[var(--color-on-tint)] shrink-0">
            {prefix === "t" ? "Tasks" : prefix === "c" ? "Calendar" : "PDFs"}
          </span>
        )}

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={activePlaceholder}
          className="flex-1 bg-transparent border-none outline-none text-base placeholder-[var(--color-dim)] text-[var(--color-text)] font-medium"
          autoFocus
        />

        {query && (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="p-1 rounded hover:bg-[var(--color-fill-2)] text-[var(--color-dim)] transition-colors"
            title="Borrar búsqueda"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Prefix Mode Selector Chips */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-[var(--color-border)]/50 bg-[var(--color-fill-1)]/20 text-xs">
        <span className="text-[var(--color-dim)] mr-1">Modos:</span>
        {PREFIX_CHIPS.map((chip) => {
          const isActive = prefix === chip.id;
          return (
            <button
              key={chip.id}
              onClick={() => selectPrefix(chip.id)}
              className={`px-2 py-1 rounded-md transition-all font-medium ${
                isActive
                  ? "bg-[var(--color-tint)] text-[var(--color-on-tint)] shadow-sm"
                  : "bg-[var(--color-fill-1)] hover:bg-[var(--color-fill-2)] text-[var(--color-dim)] hover:text-[var(--color-text)]"
              }`}
            >
              {chip.label}
            </button>
          );
        })}

        {feedback && (
          <div className="ml-auto text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 animate-fade-in">
            {feedback}
          </div>
        )}
      </div>

      {/* Results Container */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2 py-2 space-y-1 focus:outline-none">
        {loading && results.length === 0 && (
          <div className="flex items-center justify-center py-12 text-[var(--color-dim)] text-sm">
            Buscando instantáneamente...
          </div>
        )}

        {!loading && query && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-[var(--color-dim)] text-sm gap-1">
            <span>No se encontraron resultados para &ldquo;{query}&rdquo;</span>
            <span className="text-xs">Prueba con &ldquo;t &rdquo; para Tareas, &ldquo;c &rdquo; para Calendario o fórmulas matemáticas.</span>
          </div>
        )}

        {!query && (
          <div className="flex flex-col items-center justify-center py-10 text-[var(--color-dim)] text-xs gap-3">
            <div className="grid grid-cols-2 gap-2 text-left max-w-sm">
              <div className="p-2 rounded bg-[var(--color-fill-1)]">
                <span className="font-semibold text-[var(--color-text)]">Búsqueda Universal:</span>
                <p>Escribe cualquier app, apunte o archivo prioritario.</p>
              </div>
              <div className="p-2 rounded bg-[var(--color-fill-1)]">
                <span className="font-semibold text-[var(--color-text)]">Cálculo en vivo:</span>
                <p>Fórmulas como <code className="text-amber-400">1/(2*pi*10k*100n)</code>, <code className="text-amber-400">0xFF -&gt; bin</code>.</p>
              </div>
              <div className="p-2 rounded bg-[var(--color-fill-1)]">
                <span className="font-semibold text-[var(--color-text)]">t &lt;tarea&gt;:</span>
                <p>Crear tarea directa en Google Tasks.</p>
              </div>
              <div className="p-2 rounded bg-[var(--color-fill-1)]">
                <span className="font-semibold text-[var(--color-text)]">p &lt;concepto&gt;:</span>
                <p>Buscar dentro de los PDFs de Facultad.</p>
              </div>
            </div>
            {statusText && <span className="opacity-70 mt-2">{statusText}</span>}
          </div>
        )}

        {results.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <div
              key={item.id}
              data-omni-item
              onClick={() => {
                setSelectedIndex(index);
                void handleOpen(item);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                isSelected
                  ? "bg-[var(--color-tint)] text-[var(--color-on-tint)] shadow-sm"
                  : "hover:bg-[var(--color-fill-1)] text-[var(--color-text)]"
              }`}
            >
              {/* Category Icon Badge */}
              <div
                className={`p-2 rounded-md shrink-0 flex items-center justify-center ${
                  isSelected
                    ? "bg-white/20 text-white"
                    : item.category === "calc"
                      ? "bg-emerald-500/20 text-emerald-400"
                      : item.category === "app"
                        ? "bg-blue-500/20 text-blue-400"
                        : item.category === "pdf"
                          ? "bg-rose-500/20 text-rose-400"
                          : item.category === "action"
                            ? "bg-purple-500/20 text-purple-400"
                            : "bg-amber-500/20 text-amber-400"
                }`}
              >
                {item.category === "calc" && <Calculator size={18} weight="bold" />}
                {item.category === "app" && <RocketLaunch size={18} weight="bold" />}
                {item.category === "pdf" && <FilePdf size={18} weight="bold" />}
                {item.category === "file" && (item.icon === "folder" ? <Folder size={18} weight="bold" /> : <File size={18} weight="bold" />)}
                {item.category === "action" && (item.icon === "calendar" ? <CalendarBlank size={18} weight="bold" /> : <CheckCircle size={18} weight="bold" />)}
              </div>

              {/* Title & Subtitle */}
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-semibold truncate ${isSelected ? "text-white" : "text-[var(--color-text)]"}`}>
                  {item.title}
                </div>
                <div
                  className={`text-xs truncate ${
                    isSelected ? "text-white/80" : "text-[var(--color-dim)]"
                  }`}
                >
                  {item.subtitle}
                </div>
              </div>

              {/* Category Badge & Action hint */}
              <div className="shrink-0 flex items-center gap-2">
                <span
                  className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded tracking-wider ${
                    isSelected ? "bg-white/20 text-white" : "bg-[var(--color-fill-2)] text-[var(--color-dim)]"
                  }`}
                >
                  {item.category}
                </span>

                {isSelected && (
                  <ArrowBendDownLeft size={16} className="text-white opacity-90 shrink-0" weight="bold" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer Navigation Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--color-border)]/50 bg-[var(--color-fill-1)]/30 text-[11px] text-[var(--color-dim)]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-fill-2)] border border-[var(--color-border)] font-mono text-[10px]">↵</kbd>
            <span>Abrir</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-fill-2)] border border-[var(--color-border)] font-mono text-[10px]">Ctrl+↵</kbd>
            <span>Explorador</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-fill-2)] border border-[var(--color-border)] font-mono text-[10px]">Shift+↵</kbd>
            <span>Shelf</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-fill-2)] border border-[var(--color-border)] font-mono text-[10px]">Tab</kbd>
            <span>Autocompletar</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-fill-2)] border border-[var(--color-border)] font-mono text-[10px]">Esc</kbd>
            <span>Cerrar</span>
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[10px]">
          <span className="px-1.5 py-0.5 rounded bg-[var(--color-fill-2)]">Alt+Space</span>
        </div>
      </div>
    </div>
  );
}

export default OmniSearchView;
