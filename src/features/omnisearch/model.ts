export type PrefixMode = "" | "t" | "c" | "p";

export interface ParsedQuery {
  prefix: PrefixMode;
  cleanQuery: string;
}

export function parsePrefix(query: string): ParsedQuery {
  const trimmed = query.trimStart();
  if (trimmed.startsWith("t ") || trimmed.startsWith("t:")) {
    return { prefix: "t", cleanQuery: trimmed.slice(2).trimStart() };
  }
  if (trimmed.startsWith("c ") || trimmed.startsWith("c:")) {
    return { prefix: "c", cleanQuery: trimmed.slice(2).trimStart() };
  }
  if (trimmed.startsWith("p ") || trimmed.startsWith("p:")) {
    return { prefix: "p", cleanQuery: trimmed.slice(2).trimStart() };
  }
  return { prefix: "", cleanQuery: query };
}

export interface OmniResult {
  id: string;
  title: string;
  subtitle: string;
  category: "app" | "file" | "calc" | "pdf" | "action";
  icon: string;
  target: string;
  score: number;
  action_data?: string | null;
}

export function evaluateLiveMath(input: string): { display: string; subtitle: string; raw_val: string } | null {
  const q = input.trim();
  if (!q) return null;

  // Conversions: 0xFF -> bin, 0b1010 -> hex, 100 -> bin
  const convMatch = q.match(/^(0x[0-9a-fA-F]+|0b[01]+|\d+)\s*(?:->|to|as)\s*(bin|hex|dec|oct)/i);
  if (convMatch) {
    const rawNum = convMatch[1];
    const targetBase = convMatch[2].toLowerCase();
    const val = rawNum.startsWith("0x") || rawNum.startsWith("0X")
      ? parseInt(rawNum.slice(2), 16)
      : rawNum.startsWith("0b") || rawNum.startsWith("0B")
        ? parseInt(rawNum.slice(2), 2)
        : parseInt(rawNum, 10);

    if (!isNaN(val)) {
      if (targetBase === "bin") {
        return {
          display: `0b${val.toString(2)} (${val})`,
          subtitle: `Convertido a Binario | Dec: ${val}, Hex: 0x${val.toString(16).toUpperCase()}`,
          raw_val: `0b${val.toString(2)}`,
        };
      }
      if (targetBase === "hex") {
        return {
          display: `0x${val.toString(16).toUpperCase()} (${val})`,
          subtitle: `Convertido a Hexadecimal | Dec: ${val}, Bin: 0b${val.toString(2)}`,
          raw_val: `0x${val.toString(16).toUpperCase()}`,
        };
      }
      if (targetBase === "dec") {
        return {
          display: `${val} (0x${val.toString(16).toUpperCase()})`,
          subtitle: `Convertido a Decimal | Hex: 0x${val.toString(16).toUpperCase()}, Bin: 0b${val.toString(2)}`,
          raw_val: `${val}`,
        };
      }
    }
  }

  // Engineering units multiplier replacement: 10k -> 10000, 100n -> 100e-9
  let expr = q
    .replace(/(\d+(?:\.\d+)?)\s*k\b/gi, "($1*1e3)")
    .replace(/(\d+(?:\.\d+)?)\s*M\b/g, "($1*1e6)")
    .replace(/(\d+(?:\.\d+)?)\s*G\b/gi, "($1*1e9)")
    .replace(/(\d+(?:\.\d+)?)\s*m\b/g, "($1*1e-3)")
    .replace(/(\d+(?:\.\d+)?)\s*[uµ]\b/gi, "($1*1e-6)")
    .replace(/(\d+(?:\.\d+)?)\s*n\b/gi, "($1*1e-9)")
    .replace(/(\d+(?:\.\d+)?)\s*p\b/gi, "($1*1e-12)");

  expr = expr
    .replace(/\bpi\b/gi, "Math.PI")
    .replace(/\be\b/gi, "Math.E")
    .replace(/\blog10\(/gi, "Math.log10(")
    .replace(/\bln\(/gi, "Math.log(")
    .replace(/\bsqrt\(/gi, "Math.sqrt(");

  if (!/[+\-*/^%]/.test(expr) && !expr.includes("Math.")) {
    return null;
  }

  try {
    const val = Function(`"use strict"; return (${expr})`)();
    if (typeof val === "number" && !isNaN(val) && isFinite(val)) {
      const isFc = q.includes("1/(2*pi") || q.includes("1 / (2 * pi");
      const isGain = q.includes("20*log10") || q.includes("20 * log10");

      let display = String(val);
      let subtitle = `= ${val} (Cálculo en vivo)`;

      if (isFc) {
        if (val >= 1e6) display = `${(val / 1e6).toFixed(3)} MHz`;
        else if (val >= 1e3) display = `${(val / 1e3).toFixed(3)} kHz`;
        else display = `${val.toFixed(3)} Hz`;
        subtitle = `Frecuencia de Corte fc = ${val.toFixed(4)} Hz (1/(2·π·R·C))`;
      } else if (isGain) {
        display = `${val.toFixed(3)} dB`;
        subtitle = `Ganancia = ${val.toFixed(4)} dB`;
      } else {
        display = val % 1 === 0 ? String(val) : parseFloat(val.toFixed(6)).toString();
      }

      return { display, subtitle, raw_val: String(val) };
    }
  } catch {}

  return null;
}

export function mockOmniQuery(query: string, prefix?: string | null): OmniResult[] {
  const { prefix: effPrefix, cleanQuery } = parsePrefix(query);
  const activePrefix = prefix || effPrefix;
  const q = (activePrefix ? cleanQuery : query).trim();
  const res: OmniResult[] = [];
  if (!q && !activePrefix) return res;

  if (activePrefix === "t") {
    const taskText = q || "Nueva tarea";
    return [
      {
        id: "action_task",
        title: `Crear Tarea: "${taskText}"`,
        subtitle: "Presiona Enter para crear en Google Tasks / To-Dos",
        category: "action",
        icon: "task",
        target: `action:task:${taskText}`,
        score: 1000,
        action_data: taskText,
      },
    ];
  }

  if (activePrefix === "c") {
    const eventText = q || "Nuevo evento";
    return [
      {
        id: "action_calendar",
        title: `Agendar Evento: "${eventText}"`,
        subtitle: "Presiona Enter para agendar en Google Calendar",
        category: "action",
        icon: "calendar",
        target: `action:calendar:${eventText}`,
        score: 1000,
        action_data: eventText,
      },
    ];
  }

  if (activePrefix === "p") {
    return [
      {
        id: "pdf_mock_1",
        title: `Apunte - ${q}.pdf (Pág. 42)`,
        subtitle: `Documentos/Facultad/Control • Coincidencia para "${q}"`,
        category: "pdf",
        icon: "pdf",
        target: `C:\\Users\\User\\Documents\\Facultad\\${q}.pdf`,
        score: 900,
        action_data: "42",
      },
    ];
  }

  // Universal Live Math
  const math = evaluateLiveMath(q);
  if (math) {
    res.push({
      id: "calc_result",
      title: math.display,
      subtitle: math.subtitle,
      category: "calc",
      icon: "calc",
      target: `calc:${math.raw_val}`,
      score: 2000,
      action_data: math.raw_val,
    });
  }

  if (q.toLowerCase().includes("elctrdig") || q.toLowerCase().includes("electr")) {
    res.push({
      id: "mock_app_1",
      title: "Electrónica Digital",
      subtitle: "Aplicación instalada • Facultad",
      category: "app",
      icon: "app",
      target: "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Electronica_Digital.lnk",
      score: 1200,
    });
  }

  return res;
}
