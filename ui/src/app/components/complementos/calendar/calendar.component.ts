import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Agent, ApiService, CalendarEntry, CalendarEntryInput } from '../../../services/api.service';
import { ComplementosService } from '../../../services/complementos.service';
import { IconComponent } from '../../icon/icon.component';

// The shared calendar (Complementos → Calendar): what the agents and the user put there,
// by day. Month, week and day views over the same entries; an agenda of the coming days on
// the left; one entry's detail on the right, with a form to add or change entries. Dates are
// the entry's own local date (the API gives date/time in the entry's zone), so an entry
// made in another zone sits on the day it was meant for there.
type View = 'month' | 'week' | 'day';
type Form = { id?: string; kind: 'note' | 'action'; title: string; date: string; time: string; allDay: boolean; timezone: string; notes: string; repeat: CalendarEntry['repeat']; repeatUntil: string; agentId: string; prompt: string };

const DAY_MS = 86_400_000;
const PALETTE = ['#6366f1', '#0ea5e9', '#f59e0b', '#14b8a6', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444', '#f97316', '#06b6d4'];

/** YYYY-MM-DD arithmetic on calendar days, zone-free (the strings are already local). */
const toUtc = (d: string) => new Date(`${d}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(toUtc(d).getTime() + n * DAY_MS));
/** Monday of the week that holds the day (ISO weeks). */
const mondayOf = (d: string) => addDays(d, -((toUtc(d).getUTCDay() + 6) % 7));

@Component({
  selector: 'app-calendar',
  standalone: true,
  imports: [FormsModule, DatePipe, TranslatePipe, IconComponent],
  templateUrl: './calendar.component.html',
  styleUrl: './calendar.component.css',
})
export class CalendarComponent implements OnInit {
  readonly api = inject(ApiService);
  private readonly i18n = inject(TranslateService);
  private readonly complementos = inject(ComplementosService);

  back(): void { this.complementos.openHub(); }

  readonly view = signal<View>('month');
  /** The day the views are built around (the month shown, the week shown, the day shown). */
  readonly cursor = signal(this.localToday('UTC'));
  readonly tz = signal('');
  readonly today = signal(this.localToday('UTC'));
  readonly entries = signal<CalendarEntry[]>([]);
  readonly agents = signal<Agent[]>([]);
  readonly search = signal('');
  readonly selected = signal<CalendarEntry | null>(null);
  readonly form = signal<Form | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly confirmRemove = signal(false);
  readonly loading = signal(true);

  readonly weekdays = computed(() => this.weekdayNames('short'));
  readonly weekdaysMini = computed(() => this.weekdayNames('narrow'));

  /** The 42 days of the month grid, from the Monday before the 1st. */
  readonly monthDays = computed(() => {
    const first = this.cursor().slice(0, 8) + '01';
    const start = mondayOf(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  });
  readonly weekDays = computed(() => { const m = mondayOf(this.cursor()); return Array.from({ length: 7 }, (_, i) => addDays(m, i)); });
  readonly miniDays = computed(() => this.monthDays());
  readonly monthLabel = computed(() => this.monthName(this.cursor()));
  readonly weekLabel = computed(() => { const d = this.weekDays(); return `${this.dayLabel(d[0])} – ${this.dayLabel(d[6])}`; });

  /** Entries by local date, with the search applied; cancelled ones stay out. */
  readonly byDay = computed(() => {
    const q = this.search().trim().toLowerCase();
    const map = new Map<string, CalendarEntry[]>();
    for (const e of this.entries()) {
      if (e.status === 'cancelled') continue;
      if (q && !`${e.title} ${e.notes ?? ''} ${e.prompt ?? ''} ${e.owner} ${e.agentId ?? ''}`.toLowerCase().includes(q)) continue;
      const list = map.get(e.date) ?? [];
      list.push(e);
      map.set(e.date, list);
    }
    for (const list of map.values()) list.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    return map;
  });
  /** The coming days with something on them, from the cursor on (the agenda on the left). */
  readonly agenda = computed(() => {
    const out: { date: string; entries: CalendarEntry[] }[] = [];
    for (let i = 0; i < 14 && out.length < 6; i++) {
      const d = addDays(this.cursor(), i);
      const list = this.byDay().get(d);
      if (list?.length) out.push({ date: d, entries: list });
    }
    return out;
  });
  readonly owners = computed(() => {
    const seen = new Map<string, string>();
    seen.set('user', this.i18n.instant('calendar.you'));
    for (const a of this.agents()) seen.set(a.id, a.name);
    return [...seen.entries()].map(([id, name]) => ({ id, name, color: this.colorOf(id) }));
  });

  ngOnInit(): void {
    this.api.getCalendarSettings().subscribe({
      next: s => { this.tz.set(s.timezone); const t = this.localToday(s.timezone); this.today.set(t); this.cursor.set(t); this.load(); },
      error: () => { this.load(); },
    });
    this.api.getAgents().subscribe({ next: a => this.agents.set(a), error: () => {} });
  }

  // ── Data ──
  load(): void {
    // The grid's six weeks, plus a week on each side so moving a day does not refetch.
    const days = this.monthDays();
    const from = addDays(days[0], -7), to = addDays(days[41], 7);
    this.loading.set(true);
    this.api.listCalendar(from, to, true).subscribe({
      next: r => {
        this.entries.set(r.entries);
        if (r.timezone) this.tz.set(r.timezone);
        this.loading.set(false);
        const sel = this.selected();
        if (sel) this.selected.set(r.entries.find(e => e.id === sel.id) ?? null);
      },
      error: () => { this.loading.set(false); this.error.set(this.i18n.instant('calendar.loadError')); },
    });
  }

  // ── Navigation ──
  setView(v: View): void { this.view.set(v); }
  goToday(): void { this.cursor.set(this.today()); this.load(); }
  step(n: number): void {
    const c = this.cursor();
    if (this.view() === 'month') {
      const [y, m] = c.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + n, 1));
      this.cursor.set(iso(d));
    } else this.cursor.set(addDays(c, n * (this.view() === 'week' ? 7 : 1)));
    this.load();
  }
  pick(date: string): void { this.cursor.set(date); if (this.view() === 'month' && date.slice(0, 7) !== this.monthDays()[20].slice(0, 7)) this.load(); }
  openDay(date: string): void { this.cursor.set(date); this.view.set('day'); }
  select(e: CalendarEntry): void { this.selected.set(e); this.form.set(null); this.confirmRemove.set(false); this.error.set(''); }

  // ── Form ──
  newEntry(date?: string): void {
    this.selected.set(null);
    this.error.set('');
    this.form.set({ kind: 'note', title: '', date: date ?? this.cursor(), time: '09:00', allDay: false, timezone: this.tz(), notes: '', repeat: 'none', repeatUntil: '', agentId: this.agents()[0]?.id ?? '', prompt: '' });
  }
  edit(e: CalendarEntry): void {
    this.error.set('');
    this.form.set({ id: e.id, kind: e.kind, title: e.title, date: e.date, time: e.time ?? '09:00', allDay: !e.time, timezone: e.timezone, notes: e.notes ?? '', repeat: e.repeat, repeatUntil: e.repeatUntil ?? '', agentId: e.agentId ?? this.agents()[0]?.id ?? '', prompt: e.prompt ?? '' });
  }
  cancelForm(): void { this.form.set(null); }
  patchForm(patch: Partial<Form>): void { this.form.update(f => (f ? { ...f, ...patch } : f)); }
  save(): void {
    const f = this.form();
    if (!f || this.busy()) return;
    if (!f.title.trim()) { this.error.set(this.i18n.instant('calendar.form.needTitle')); return; }
    if (f.kind === 'action' && !f.prompt.trim()) { this.error.set(this.i18n.instant('calendar.form.needPrompt')); return; }
    const body: CalendarEntryInput = {
      kind: f.kind, title: f.title.trim(), date: f.date, time: f.allDay ? null : f.time, timezone: f.timezone || undefined, notes: f.notes.trim() || null,
      repeat: f.repeat, repeatUntil: f.repeat !== 'none' && f.repeatUntil ? f.repeatUntil : null,
      ...(f.kind === 'action' ? { agentId: f.agentId, prompt: f.prompt.trim() } : {}),
    };
    this.busy.set(true);
    this.error.set('');
    const call = f.id ? this.api.updateCalendarEntry(f.id, body) : this.api.addCalendarEntry(body);
    call.subscribe({
      next: r => {
        this.busy.set(false);
        this.form.set(null);
        this.selected.set(r.entry);
        this.cursor.set(r.entry.date);
        this.notice.set(this.i18n.instant(f.id ? 'calendar.saved' : 'calendar.added'));
        setTimeout(() => this.notice.set(''), 2500);
        this.load();
      },
      error: err => { this.busy.set(false); this.error.set(String(err?.error?.error ?? this.i18n.instant('calendar.saveError'))); },
    });
  }
  remove(e: CalendarEntry): void {
    if (!this.confirmRemove()) { this.confirmRemove.set(true); return; }
    this.busy.set(true);
    this.api.removeCalendarEntry(e.id).subscribe({
      next: () => { this.busy.set(false); this.confirmRemove.set(false); this.selected.set(null); this.load(); },
      error: err => { this.busy.set(false); this.confirmRemove.set(false); this.error.set(String(err?.error?.error ?? this.i18n.instant('calendar.saveError'))); },
    });
  }

  // ── Presentation ──
  colorOf(owner: string): string {
    if (owner === 'user') return 'var(--text-primary)';
    const ids = this.agents().map(a => a.id);
    const i = ids.indexOf(owner);
    return PALETTE[(i >= 0 ? i : owner.length) % PALETTE.length];
  }
  ownerName(id: string | null | undefined): string {
    if (!id) return '';
    if (id === 'user') return this.i18n.instant('calendar.you');
    return this.agents().find(a => a.id === id)?.name ?? id;
  }
  inMonth(date: string): boolean { return date.slice(0, 7) === this.cursor().slice(0, 7); }
  dayNumber(date: string): string { const n = Number(date.slice(8, 10)); return n === 1 ? `1 ${this.shortMonth(date)}` : String(n); }
  dayLabel(date: string): string {
    try { return new Intl.DateTimeFormat(this.i18n.currentLang() || 'en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(toUtc(date)); } catch { return date; }
  }
  longDay(date: string): string {
    try { return new Intl.DateTimeFormat(this.i18n.currentLang() || 'en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toUtc(date)); } catch { return date; }
  }
  agendaHead(date: string): string {
    if (date === this.today()) return this.i18n.instant('calendar.today');
    if (date === addDays(this.today(), 1)) return this.i18n.instant('calendar.tomorrow');
    return this.dayLabel(date);
  }
  whenText(e: CalendarEntry): string { return `${this.longDay(e.date)}${e.time ? ` · ${e.time}` : ` · ${this.i18n.instant('calendar.allDay')}`}`; }
  statusKey(e: CalendarEntry): string { return 'calendar.status.' + e.status; }
  attachmentUrl(path: string): string { return this.api.storageUrl(path.replace(/^storage\//, '')); }
  kb(n: number): string { return `${Math.max(1, Math.round(n / 1024))} KB`; }

  private monthName(date: string): string {
    try {
      const s = new Intl.DateTimeFormat(this.i18n.currentLang() || 'en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(toUtc(date));
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch { return date.slice(0, 7); }
  }
  private shortMonth(date: string): string {
    try { return new Intl.DateTimeFormat(this.i18n.currentLang() || 'en', { month: 'short', timeZone: 'UTC' }).format(toUtc(date)); } catch { return date.slice(5, 7); }
  }
  private weekdayNames(width: 'short' | 'narrow'): string[] {
    const monday = '2024-01-01';
    return Array.from({ length: 7 }, (_, i) => {
      try { return new Intl.DateTimeFormat(this.i18n.currentLang() || 'en', { weekday: width, timeZone: 'UTC' }).format(toUtc(addDays(monday, i))); } catch { return String(i); }
    });
  }
  private localToday(tz: string): string {
    try {
      const p: Record<string, string> = {};
      for (const part of new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) if (part.type !== 'literal') p[part.type] = part.value;
      return `${p['year']}-${p['month']}-${p['day']}`;
    } catch { return iso(new Date()); }
  }
}
