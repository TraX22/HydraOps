// Human schedule phrases ⇄ 5-field cron expressions, for /cron and /crons.
// Accepts English and Spanish and only emits the syntax the orchestrator's
// matcher understands: '*', numbers, lists, ranges and '*/n' steps.

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

const DAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6,
};
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const TIME = /^(\d{1,2}):(\d{2})$/;
const CRON = /^(\S+\s+){4}\S+$/;

function time(t: string): [number, number] | null {
  const m = t.match(TIME);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? [h, mi] : null;
}

function days(spec: string): string | null {
  // "mon-fri", "lun-vie", "mon,wed,fri"
  const range = spec.match(/^([a-z]{3})-([a-z]{3})$/);
  if (range) {
    const a = DAYS[range[1]];
    const b = DAYS[range[2]];
    if (a === undefined || b === undefined) return null;
    return a <= b ? `${a}-${b}` : null;
  }
  const parts = spec.split(",");
  const nums = parts.map((p) => DAYS[p]);
  if (nums.some((n) => n === undefined)) return null;
  return [...new Set(nums)].sort((x, y) => x - y).join(",");
}

/**
 * "5m", "every 10 min", "cada 30 minutos", "hourly", "cada hora :15",
 * "09:00", "daily 09:00", "diario 21:30", "weekdays 09:00", "mon-fri 09:00",
 * "lun,mie,vie 18:00", "monthly 1 09:00", "mensual 15 08:00", "noon",
 * "midnight", or a raw 5-field cron expression. Anything else → null.
 */
export function parseSchedule(text: string): string | null {
  const t = fold(text).replace(/\s+/g, " ");
  if (!t) return null;
  if (CRON.test(t) && /^[\d*,\-\/ ]+$/.test(t)) return t;

  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:every |cada )?(\d{1,2}) ?(?:m|min|mins|minutes?|minutos?)$/))) {
    const n = Number(m[1]);
    return n <= 1 ? "* * * * *" : n < 60 ? `*/${n} * * * *` : null;
  }
  if ((m = t.match(/^(?:hourly|every hour|cada hora)(?: (?:at|en)? ?:?(\d{1,2}))?$/))) {
    const mi = m[1] ? Number(m[1]) : 0;
    return mi < 60 ? `${mi} * * * *` : null;
  }
  if (t === "noon" || t === "mediodia") return "0 12 * * *";
  if (t === "midnight" || t === "medianoche") return "0 0 * * *";
  if ((m = t.match(/^(?:(?:daily|every day|diario|todos los dias) )?(\d{1,2}:\d{2})$/))) {
    const tm = time(m[1]);
    return tm ? `${tm[1]} ${tm[0]} * * *` : null;
  }
  if ((m = t.match(/^(?:weekdays|laborables|mon-fri|lun-vie) (\d{1,2}:\d{2})$/))) {
    const tm = time(m[1]);
    return tm ? `${tm[1]} ${tm[0]} * * 1-5` : null;
  }
  if ((m = t.match(/^([a-z]{3}(?:[,\-][a-z]{3})*) (\d{1,2}:\d{2})$/))) {
    const dow = days(m[1]);
    const tm = time(m[2]);
    return dow && tm ? `${tm[1]} ${tm[0]} * * ${dow}` : null;
  }
  if ((m = t.match(/^(?:monthly|every month|mensual|cada mes) (\d{1,2}) (\d{1,2}:\d{2})$/))) {
    const d = Number(m[1]);
    const tm = time(m[2]);
    return d >= 1 && d <= 31 && tm ? `${tm[1]} ${tm[0]} ${d} * *` : null;
  }
  return null;
}

/** Cron expression → short English phrase; unknown shapes come back verbatim. */
export function describeSchedule(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [mi, ho, dom, mon, dow] = p;
  const hhmm = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const isNum = (s: string) => /^\d+$/.test(s);
  if (mon !== "*") return expr;
  if (mi === "*" && ho === "*" && dom === "*" && dow === "*") return "every minute";
  const step = mi.match(/^\*\/(\d+)$/);
  if (step && ho === "*" && dom === "*" && dow === "*") return `every ${step[1]} min`;
  if (isNum(mi) && ho === "*" && dom === "*" && dow === "*") return `hourly at :${mi.padStart(2, "0")}`;
  if (isNum(mi) && isNum(ho)) {
    const at = hhmm(ho, mi);
    if (dom === "*" && dow === "*") return `daily ${at}`;
    if (dom === "*" && dow === "1-5") return `Mon–Fri ${at}`;
    const range = dow.match(/^(\d)-(\d)$/);
    if (dom === "*" && range) return `${DAY_NAMES[Number(range[1])]}–${DAY_NAMES[Number(range[2])]} ${at}`;
    if (dom === "*" && /^\d(,\d)*$/.test(dow)) return `${dow.split(",").map((d) => DAY_NAMES[Number(d)]).join(", ")} ${at}`;
    if (isNum(dom) && dow === "*") return `day ${dom} ${at}`;
  }
  return expr;
}
