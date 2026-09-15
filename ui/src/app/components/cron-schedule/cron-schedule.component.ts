import { Component, computed, effect, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';

// Frequencies the picker can express. Everything else the user may type
// stays a raw 5-field expression ('custom').
type Mode = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

interface Preset {
  labelKey: string;
  value: string;
}

/**
 * Schedule picker for cron jobs. Edits a 5-field cron expression through
 * plain choices (every N minutes, daily at HH:MM, weekdays, …) and only
 * exposes the raw expression in the custom mode. Parses whatever expression
 * it receives back into those choices, so existing jobs open in the picker
 * they would have been created with. Emits only the syntax the orchestrator's
 * matcher understands: '*', numbers, lists, ranges and '*\/n' steps.
 */
@Component({
  selector: 'app-cron-schedule',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './cron-schedule.component.html',
  styleUrl: './cron-schedule.component.css',
})
export class CronScheduleComponent {
  value = input<string>('');
  valueChange = output<string>();

  readonly modes: Mode[] = ['minutes', 'hourly', 'daily', 'weekly', 'monthly', 'custom'];
  // Cron numbers days Sunday=0; shown Monday-first as people plan their week.
  readonly weekDays = [
    { n: 1, key: 'mon' }, { n: 2, key: 'tue' }, { n: 3, key: 'wed' }, { n: 4, key: 'thu' },
    { n: 5, key: 'fri' }, { n: 6, key: 'sat' }, { n: 0, key: 'sun' },
  ];
  readonly presets: Preset[] = [
    { labelKey: 'cron.every5min', value: '*/5 * * * *' },
    { labelKey: 'cron.every30min', value: '*/30 * * * *' },
    { labelKey: 'cron.hourly', value: '0 * * * *' },
    { labelKey: 'cron.noon', value: '0 12 * * *' },
    { labelKey: 'cron.midnight', value: '0 0 * * *' },
    { labelKey: 'cron.workHours', value: '0 9-17 * * 1-5' },
  ];

  mode = signal<Mode>('daily');
  everyMinutes = signal(5);
  minute = signal(0);
  time = signal('09:00');
  days = signal<number[]>([1, 2, 3, 4, 5]);
  dayOfMonth = signal(1);
  custom = signal('');

  // What the choices amount to, in cron syntax.
  expression = computed(() => {
    const [h, m] = this.time().split(':').map(Number);
    switch (this.mode()) {
      case 'minutes': return this.everyMinutes() <= 1 ? '* * * * *' : `*/${this.everyMinutes()} * * * *`;
      case 'hourly': return `${this.minute()} * * * *`;
      case 'daily': return `${m} ${h} * * *`;
      case 'weekly': {
        const days = [...this.days()].sort((a, b) => a - b);
        return `${m} ${h} * * ${days.length ? days.join(',') : '*'}`;
      }
      case 'monthly': return `${m} ${h} ${this.dayOfMonth()} * *`;
      default: return this.custom().trim();
    }
  });

  // The last expression exchanged with the parent, in either direction, so a
  // value we just emitted is not parsed back and a value we just parsed is
  // not echoed.
  private lastExchanged = '';

  constructor() {
    effect(() => {
      const incoming = this.value();
      if (incoming !== this.lastExchanged) this.parse(incoming);
    });
    effect(() => {
      const expr = this.expression();
      if (expr !== this.lastExchanged) {
        this.lastExchanged = expr;
        this.valueChange.emit(expr);
      }
    });
  }

  applyPreset(value: string): void {
    this.parse(value);
    // Presets use ranges ('9-17', '1-5') the choices keep as-is only in
    // custom mode; whatever the parse produced is what gets emitted.
    this.lastExchanged = '';
  }

  toggleDay(n: number): void {
    this.days.update(d => d.includes(n) ? d.filter(x => x !== n) : [...d, n]);
  }

  clampMinutes(v: unknown, lo: number, hi: number, fallback: number): number {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  // Cron expression → picker choices. Anything the choices cannot represent
  // exactly opens in custom mode with the text untouched.
  private parse(raw: string): void {
    this.lastExchanged = raw;
    const v = raw.trim();
    const p = v.split(/\s+/);
    const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
    if (!v) { this.mode.set('daily'); return; }
    if (p.length === 5) {
      const [mi, ho, dom, mon, dow] = p;
      const m = num(mi);
      const h = num(ho);
      const allStar = (...f: string[]) => f.every(x => x === '*');
      const step = mi.match(/^\*\/(\d+)$/);
      if (mon === '*') {
        if (allStar(mi, ho, dom, dow)) { this.mode.set('minutes'); this.everyMinutes.set(1); return; }
        if (step && allStar(ho, dom, dow)) { this.mode.set('minutes'); this.everyMinutes.set(Number(step[1])); return; }
        if (m !== null && allStar(ho, dom, dow)) { this.mode.set('hourly'); this.minute.set(m); return; }
        if (m !== null && h !== null && m < 60 && h < 24) {
          const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
          if (allStar(dom, dow)) { this.mode.set('daily'); this.time.set(t); return; }
          if (dom === '*' && /^[0-6](,[0-6])*$/.test(dow)) {
            this.mode.set('weekly'); this.time.set(t); this.days.set(dow.split(',').map(Number)); return;
          }
          if (dom === '*' && /^[0-6]-[0-6]$/.test(dow)) {
            const [a, b] = dow.split('-').map(Number);
            if (a <= b) {
              const days = Array.from({ length: b - a + 1 }, (_, i) => a + i);
              this.mode.set('weekly'); this.time.set(t); this.days.set(days); return;
            }
          }
          const d = num(dom);
          if (d !== null && d >= 1 && d <= 31 && dow === '*') {
            this.mode.set('monthly'); this.time.set(t); this.dayOfMonth.set(d); return;
          }
        }
      }
    }
    this.mode.set('custom');
    this.custom.set(v);
  }
}
