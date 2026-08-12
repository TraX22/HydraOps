import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import {
  ApiService,
  McpConfig,
  McpStatusResponse,
  NativeAddon,
} from '../../services/api.service';

const STATUS_POLL_MS = 15_000;

@Component({
  selector: 'app-addons',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './addons.component.html',
  styleUrl: './addons.component.css',
})
export class AddonsComponent implements OnInit {
  private api = inject(ApiService);

  nativeAddons = signal<NativeAddon[]>([]);
  mcpConfig = signal<McpConfig>({ mcpServers: {} });
  mcpStatus = signal<McpStatusResponse | null>(null);

  // JSON editor
  editingJson = signal(false);
  jsonText = signal('');
  jsonError = signal('');
  jsonSaved = signal(false);

  constructor() {
    const timer = setInterval(() => this.refreshStatus(), STATUS_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  ngOnInit(): void {
    this.api.getNativeAddons().subscribe(r => this.nativeAddons.set(r.addons));
    this.api.getMcpConfig().subscribe(c => this.mcpConfig.set(c));
    this.refreshStatus();
  }

  refreshStatus(): void {
    this.api.getMcpStatus().subscribe(s => this.mcpStatus.set(s));
  }

  // ── Native addons ──
  toggleNative(addon: NativeAddon): void {
    const updated = this.nativeAddons().map(a =>
      a.name === addon.name ? { ...a, enabled: !a.enabled } : a
    );
    this.nativeAddons.set(updated);
    const state: Record<string, boolean> = {};
    for (const a of updated) state[a.name] = a.enabled;
    this.api.saveNativeAddons(state).subscribe();
  }

  // ── MCP servers ──
  toggleServer(name: string): void {
    const cfg = this.mcpConfig();
    const next = cfg.mcpServers[name]?.switch === 'on' ? 'off' as const : 'on' as const;
    const updated: McpConfig = {
      mcpServers: { ...cfg.mcpServers, [name]: { ...cfg.mcpServers[name], switch: next } },
    };
    this.mcpConfig.set(updated);
    this.api.saveMcpConfig(updated).subscribe(() => this.refreshStatus());
  }

  stateColor(state: string): string {
    switch (state) {
      case 'connected': return 'var(--status-online)';
      case 'connecting': return 'var(--status-working)';
      case 'failed':
      case 'timeout': return '#ef4444';
      case 'unknown': return '#f59e0b';
      default: return 'var(--text-muted)'; // off / disconnected
    }
  }

  // ── JSON editor ──
  openJsonEditor(): void {
    this.jsonText.set(JSON.stringify(this.mcpConfig(), null, 2));
    this.jsonError.set('');
    this.editingJson.set(true);
  }

  cancelJson(): void {
    this.editingJson.set(false);
    this.jsonError.set('');
  }

  saveJson(): void {
    this.jsonError.set('');
    let parsed: McpConfig;
    try {
      parsed = JSON.parse(this.jsonText());
    } catch {
      this.jsonError.set('invalid');
      return;
    }
    if (!parsed || typeof parsed.mcpServers !== 'object' || parsed.mcpServers === null) {
      this.jsonError.set('structure');
      return;
    }
    this.api.saveMcpConfig(parsed).subscribe(() => {
      this.mcpConfig.set(parsed);
      this.editingJson.set(false);
      this.jsonSaved.set(true);
      setTimeout(() => this.jsonSaved.set(false), 2000);
      this.refreshStatus();
    });
  }
}
