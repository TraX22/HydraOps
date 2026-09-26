import { Component, inject, OnInit, OnDestroy, signal, computed, viewChild, ElementRef, afterNextRender, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ChatService, ChatTab, WHATS_NEW_TAB } from '../../services/chat.service';
import { WhatsNewService } from '../../services/whats-new.service';
import { AgentsService } from '../../services/agents.service';
import { ApiService, ChatAttachment, ChatMessage } from '../../services/api.service';
import { DatePipe } from '@angular/common';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { linkKey, type LinkCheck } from '../../pipes/sanitize-html';
import { watchMermaid } from '../../pipes/mermaid-render';
import { IconComponent } from '../../components/icon/icon.component';
import { HeldActionComponent } from '../../components/held-action/held-action.component';
import { modelLabel } from '../../shared/model-groups';
import { CommandService, PaletteItem } from '../../services/command.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, TranslatePipe, MarkdownPipe, DatePipe, IconComponent, HeldActionComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnInit, OnDestroy {
  chat = inject(ChatService);
  agents = inject(AgentsService);
  private api = inject(ApiService);
  commands = inject(CommandService);
  whatsNew = inject(WhatsNewService);
  readonly whatsNewTab = WHATS_NEW_TAB;
  readonly isWhatsNew = computed(() => this.chat.activeTab() === WHATS_NEW_TAB);
  private router = inject(Router);
  private translate = inject(TranslateService);

  // Mirrors the active chat's draft (ChatService keeps the real thing).
  inputValue = signal('');
  editingMsgId = signal<string | null>(null);
  editingText = signal('');
  copiedMsgId = signal<string | null>(null);

  messagesEnd = viewChild<ElementRef>('messagesEnd');
  messagesArea = viewChild<ElementRef<HTMLElement>>('messagesArea');

  // Floating "scroll to bottom" button: shown once the user has scrolled up
  // far enough from the latest message.
  showScrollDown = signal(false);

  // Last tab the auto-scroll effect saw, to tell "opened a chat" apart from
  // "a new message arrived in the current one".
  private lastScrolledTab = '';

  // Upgrades ```mermaid blocks in rendered messages to SVG diagrams.
  private stopMermaid?: () => void;

  constructor() {
    afterNextRender(() => {
      const area = this.messagesArea()?.nativeElement;
      if (area) this.stopMermaid = watchMermaid(area);
    });
    // Each chat keeps its own unsent text and attachments.
    effect(() => {
      const tab = this.chat.activeTab();
      this.inputValue.set(this.chat.getDraft(tab));
      this.attachments.set(this.chat.getPendingAttachments(tab));
    });
    // Opening or switching to a chat jumps to the latest message (not the first).
    // New messages in the current chat only pull the view down while the user is
    // already near the bottom, so scrolling up to read older history isn't undone.
    effect(() => {
      const tab = this.chat.activeTab();
      // Read the map so the effect also re-runs when this chat's history loads.
      const count = (this.chat.messagesByChannel()[tab] ?? []).length;
      const opened = tab !== this.lastScrolledTab;
      this.lastScrolledTab = tab;
      if (!opened && count === 0) return;
      if (opened) this.scrollToBottom('auto');
      else if (this.isNearBottom()) this.scrollToLatest();
    });
  }

  ngOnInit(): void {
    if (this.chat.activeTab() !== WHATS_NEW_TAB) {
      this.chat.fetchHistory(this.chat.activeTab());
      this.chat.startPolling(this.chat.activeTab());
    }
    this.whatsNew.check();
    this.commands.load();
    // Engine ids (Leonardo uses bare UUIDs) become readable names once the
    // shared model list arrives; until then the footer shows the id.
    this.api.getModelsShared().subscribe({
      next: models => this.modelNames.set(new Map(models.map(m => [m.id, modelLabel(m.name)]))),
      error: () => {},
    });
  }

  ngOnDestroy(): void {
    this.chat.stopPolling();
    this.stopMermaid?.();
  }

  // The chat's history plus the local command notes, in time order.
  get messages(): ChatMessage[] {
    const tab = this.chat.activeTab();
    const history = this.chat.messagesByChannel()[tab] ?? [];
    const notes = this.chat.systemByChannel()[tab] ?? [];
    if (!notes.length) return history;
    return [...history, ...notes].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ── Command palette ──
  // Typing "/" opens it; it lists commands and agents matching the token after
  // the slash until the first space. Enter runs the line (or completes the
  // highlighted entry while the token is still being typed).
  paletteIndex = signal(0);
  paletteOpen = computed(() => /^\/[^\s]*$/.test(this.inputValue()));
  paletteItems = computed<PaletteItem[]>(() => this.paletteOpen() ? this.commands.suggestions(this.inputValue().slice(1)) : []);

  completePalette(item: PaletteItem): void {
    this.onInput(`/${item.name} `);
    this.paletteIndex.set(0);
    this.inputField()?.nativeElement.focus();
  }

  inputField = viewChild<ElementRef<HTMLTextAreaElement>>('inputField');

  onInput(text: string): void {
    this.inputValue.set(text);
    this.chat.setDraft(this.chat.activeTab(), text);
  }

  send(): void {
    const val = this.inputValue().trim();
    if (val.startsWith('/')) {
      this.commands.run(val);
      this.onInput('');
      this.paletteIndex.set(0);
      this.scrollToBottom();
      return;
    }
    const atts = this.attachments();
    if ((!val && atts.length === 0) || this.uploadingCount() > 0) return;
    let prompt = val;
    if (atts.length > 0) {
      // Marker block parsed by the workers (buildUserMessage in @hydraops/llm)
      prompt = `${val}\n\n[ATTACHMENTS]\n${atts.map(a => `- ${a.path} (${a.mime})`).join('\n')}`.trim();
    }
    this.chat.sendMessage(prompt, this.chat.activeTab());
    this.onInput('');
    this.setAttachments([]);
    this.scrollToBottom();
  }

  // ── Agent profile from the chat ──
  // The API sends agentId with every agent message; the name and the active
  // tab remain as a safety net for old history.
  agentIdFor(msg: ChatMessage): string | null {
    if (msg.role !== 'assistant') return null;
    if (msg.agentId) return msg.agentId;
    const name = (msg.agentName ?? '').toLowerCase();
    const known = this.agents.agents().find(a => a.id === name || a.name.toLowerCase() === name);
    if (known) return known.id;
    const tab = this.chat.activeTab();
    return tab === 'main' ? null : tab;
  }

  openProfile(msg: ChatMessage): void {
    const id = this.agentIdFor(msg);
    if (id) this.router.navigate(['/agents'], { queryParams: { select: id } });
  }

  // ── Attachments ──
  attachments = signal<ChatAttachment[]>([]);
  uploadingCount = signal(0);
  attachError = signal('');
  attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');

  openAttachPicker(): void {
    this.attachError.set('');
    this.attachInput()?.nativeElement.click();
  }

  onAttachSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        this.attachError.set(`${file.name}: ${this.translate.instant('chat.attachTooBig')}`);
        continue;
      }
      this.uploadingCount.update(n => n + 1);
      this.api.uploadChatFile(file).subscribe({
        next: att => {
          this.uploadingCount.update(n => n - 1);
          this.setAttachments([...this.attachments(), att]);
        },
        error: err => {
          this.uploadingCount.update(n => n - 1);
          this.attachError.set(err?.error?.error ?? `${file.name}: upload failed`);
        },
      });
    }
  }

  removeAttachment(att: ChatAttachment): void {
    this.setAttachments(this.attachments().filter(x => x !== att));
  }

  private setAttachments(atts: ChatAttachment[]): void {
    this.attachments.set(atts);
    this.chat.setPendingAttachments(this.chat.activeTab(), atts);
  }

  isImage(mime: string): boolean {
    return mime.startsWith('image/');
  }

  fileIcon(att: { mime: string; name: string }): string {
    if (this.isImage(att.mime)) return 'image';
    const ext = att.name.split('.').pop()?.toLowerCase() ?? '';
    if (['pdf'].includes(ext)) return 'file';
    if (['csv', 'xlsx', 'xls', 'tsv'].includes(ext)) return 'stats';
    if (['md', 'txt', 'doc', 'docx', 'log'].includes(ext)) return 'file';
    return 'paperclip';
  }

  // ── Attachment rendering inside sent messages ──
  private static readonly ATTACH_RE = /\n*\[ATTACHMENTS\]\n([\s\S]*)$/;

  displayContent(msg: ChatMessage): string {
    // Backend system errors carry a code in resultMeta; show them in the
    // user's language (llm.errors.* in the locale files). The English text in
    // `content` stays as the fallback for unknown codes and for Telegram.
    const code = (msg.resultMeta as Record<string, unknown> | undefined)?.['errorCode'];
    if (typeof code === 'string' && code) {
      const key = `llm.errors.${code}`;
      const translated = this.translate.instant(key);
      if (translated !== key) return translated;
    }
    return (msg.content || '').replace(ChatComponent.ATTACH_RE, '').trim();
  }

  msgAttachments(msg: ChatMessage): { name: string; mime: string; url: string }[] {
    const m = (msg.content || '').match(ChatComponent.ATTACH_RE);
    if (!m) return [];
    return m[1]
      .split('\n').map(l => l.trim()).filter(l => l.startsWith('-'))
      .map(l => /^-\s*(.+?)\s*\(([^()]+)\)\s*$/.exec(l))
      .filter((x): x is RegExpExecArray => !!x)
      .map(x => ({
        name: x[1].split('/').pop() ?? x[1],
        mime: x[2],
        url: this.api.storageUrl(x[1].replace(/^storage\//, '')),
      }));
  }

  onKeydown(e: KeyboardEvent): void {
    if (this.paletteOpen() && this.paletteItems().length) {
      const n = this.paletteItems().length;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.paletteIndex.set((this.paletteIndex() + 1) % n); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.paletteIndex.set((this.paletteIndex() - 1 + n) % n); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const item = this.paletteItems()[Math.min(this.paletteIndex(), n - 1)];
        // An exact command name runs on Enter; anything else completes first.
        const typed = this.inputValue().slice(1).toLowerCase();
        if (e.key === 'Tab' || (item.kind === 'command' && item.name !== typed) || item.kind === 'agent') {
          e.preventDefault();
          this.completePalette(item);
          return;
        }
      }
    }
    if (e.key === 'Escape' && this.paletteOpen()) { this.onInput(''); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  switchTab(tabId: string): void {
    this.chat.switchTab(tabId);
  }

  stopTask(msg: ChatMessage): void {
    if (msg.taskId) this.chat.cancelTask(msg.taskId, this.chat.activeTab());
  }

  closeTab(tabId: string, e: Event): void {
    e.stopPropagation();
    this.chat.closeTab(tabId);
  }

  deleteMsg(msg: ChatMessage): void {
    if (msg.taskId) this.chat.deleteMessage(msg.taskId, this.chat.activeTab());
  }

  startEdit(msg: ChatMessage): void {
    this.editingMsgId.set(msg.id);
    this.editingText.set(msg.content);
  }

  saveEdit(msg: ChatMessage): void {
    if (msg.taskId) {
      this.chat.editMessage(msg.taskId, this.editingText(), this.chat.activeTab());
    }
    this.cancelEdit();
  }

  cancelEdit(): void {
    this.editingMsgId.set(null);
    this.editingText.set('');
  }

  async copyMsg(msg: ChatMessage): Promise<void> {
    await navigator.clipboard.writeText(msg.content);
    this.copiedMsgId.set(msg.id);
    setTimeout(() => this.copiedMsgId.set(null), 2000);
  }

  // ── LLM footer: which model answered and what it cost ──
  // Workers store resultMeta.modelUsed and resultMeta.usage (AI SDK shape) with
  // every completed task; image/video tasks carry the model but no usage.
  modelUsed(msg: ChatMessage): string {
    return ((msg.resultMeta as Record<string, unknown> | undefined)?.['modelUsed'] as string) || '';
  }

  // The image/video engine that rendered the result, when there is one
  // (worker-graphic stores imageModel, worker-video videoModel). Shown next
  // to the LLM so the user sees both halves of a generation.
  private modelNames = signal<Map<string, string>>(new Map());

  engineUsed(msg: ChatMessage): string {
    const meta = msg.resultMeta as Record<string, unknown> | undefined;
    const video = meta?.['videoModel'] as string | undefined;
    const image = meta?.['imageModel'] as string | undefined;
    const name = (id: string) => this.modelNames().get(id) ?? this.modelNames().get(`leonardo:${id}`) ?? id;
    return video ? `🎬 ${name(video)}` : image ? `🎨 ${name(image)}` : '';
  }

  private usageOf(msg: ChatMessage): Record<string, number> | undefined {
    return (msg.resultMeta as Record<string, unknown> | undefined)?.['usage'] as
      | Record<string, number>
      | undefined;
  }

  tokensUsed(msg: ChatMessage): number {
    return this.usageOf(msg)?.['totalTokens'] ?? 0;
  }

  // Compact display: 850 → "850", 12345 → "12.3k".
  tokensLabel(msg: ChatMessage): string {
    const n = this.tokensUsed(msg);
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  // Exact input/output split on hover (AI SDK v5+ names with the legacy
  // prompt/completion fallback). Language-neutral arrows.
  tokensTooltip(msg: ChatMessage): string {
    const u = this.usageOf(msg);
    if (!u) return '';
    const input = u['inputTokens'] ?? u['promptTokens'];
    const output = u['outputTokens'] ?? u['completionTokens'];
    const parts: string[] = [];
    if (input != null) parts.push(`↑ ${input}`);
    if (output != null) parts.push(`↓ ${output}`);
    parts.push(`Σ ${this.tokensUsed(msg)}`);
    return parts.join(' · ');
  }

  scrollToBottom(behavior: ScrollBehavior = 'smooth'): void {
    setTimeout(() => {
      this.messagesEnd()?.nativeElement.scrollIntoView({ behavior, block: 'end' });
    }, 100);
  }

  // A new message while the user is at the bottom: show it, but never scroll past the
  // start of a reply taller than the window (a long answer, an approval card): the view
  // stops at the agent's avatar and the user scrolls on from there.
  private scrollToLatest(): void {
    setTimeout(() => {
      const area = this.messagesArea()?.nativeElement;
      const rows = area?.querySelectorAll('.msg-row');
      const last = rows?.[rows.length - 1] as HTMLElement | undefined;
      if (area && last && last.getBoundingClientRect().height > area.clientHeight) {
        last.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        this.messagesEnd()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }, 100);
  }

  // Whether the message list is scrolled close to the latest message.
  private isNearBottom(): boolean {
    const el = this.messagesArea()?.nativeElement;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 240;
  }

  // Toggle the floating button based on how far the user is from the bottom.
  onMessagesScroll(): void {
    const el = this.messagesArea()?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.showScrollDown.set(distanceFromBottom > 240);
  }

  // Copy button on rendered code blocks (event delegation: the code HTML is
  // injected via [innerHTML], so there are no per-button Angular listeners).
  onMessagesClick(ev: MouseEvent): void {
    const btn = (ev.target as HTMLElement).closest('.code-copy') as HTMLElement | null;
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('.code-pre code') as HTMLElement | null;
    if (!code) return;
    navigator.clipboard.writeText(code.innerText).then(() => {
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1500);
    }).catch(() => {});
  }

  // URLs the agent's tools opened ("read") or were shown in search results ("found").
  // Links an agent's reply gives, checked against what it actually opened or saw: its own
  // task's sources and seen addresses, those of earlier replies in this chat, and any
  // address the user wrote. Replies from before seenUrls existed are not checked.
  private linkChecks = new WeakMap<ChatMessage[], Map<string, LinkCheck | null>>();
  linkCheck(msg: ChatMessage): LinkCheck | null {
    const meta = msg.resultMeta as Record<string, unknown> | undefined;
    if (msg.role !== 'assistant' || !Array.isArray(meta?.['seenUrls'])) return null;
    const all = this.messages;
    let cache = this.linkChecks.get(all);
    if (!cache) { cache = new Map(); this.linkChecks.set(all, cache); }
    if (cache.has(msg.id)) return cache.get(msg.id)!;
    const known = new Set<string>();
    const add = (u: unknown) => { if (typeof u === 'string') { const k = linkKey(u); if (k) known.add(k); } };
    for (const m of all) {
      const mm = m.resultMeta as Record<string, unknown> | undefined;
      if (m.role === 'user') for (const u of (m.content || '').match(/https?:\/\/[^\s<>"'`)\]}]+/g) ?? []) add(u);
      if (m.role === 'assistant') {
        for (const s of (Array.isArray(mm?.['sources']) ? mm!['sources'] as { url?: string }[] : [])) add(s?.url);
        for (const u of (Array.isArray(mm?.['seenUrls']) ? mm!['seenUrls'] as string[] : [])) add(u);
      }
      if (m.id === msg.id) break;
    }
    const check: LinkCheck = { known, label: this.translate.instant('chat.linkUnverified') };
    cache.set(msg.id, check);
    return check;
  }

  sources(msg: ChatMessage): { url: string; title?: string; kind: string; host: string }[] {
    const raw = (msg.resultMeta as Record<string, unknown> | undefined)?.['sources'];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is { url: string; title?: string; kind?: string } => !!s && typeof (s as any).url === 'string' && /^https?:\/\//i.test((s as any).url))
      .map(s => {
        let host = '';
        try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
        return { url: s.url, title: s.title, kind: s.kind ?? 'found', host };
      });
  }

  hasImage(msg: ChatMessage): boolean {
    const meta = msg.resultMeta as Record<string, unknown> | undefined;
    return !!meta?.['imageUrl'];
  }

  getImageUrl(msg: ChatMessage): string {
    const meta = msg.resultMeta as Record<string, unknown>;
    return this.api.storageUrl(meta['imageUrl'] as string);
  }

  // ── Media viewer: video, download + lightbox ──
  lightboxUrl = signal<string | null>(null);

  hasVideo(msg: ChatMessage): boolean {
    const meta = msg.resultMeta as Record<string, unknown> | undefined;
    return !!meta?.['videoUrl'];
  }

  getVideoUrl(msg: ChatMessage): string {
    const meta = msg.resultMeta as Record<string, unknown>;
    return this.api.storageUrl(meta['videoUrl'] as string);
  }

  downloadImage(msg: ChatMessage): Promise<void> {
    const url = this.getImageUrl(msg);
    return this.downloadFile(url, 'Imagen', this.suggestedName(msg, url, 'png'));
  }

  downloadVideo(msg: ChatMessage): Promise<void> {
    const url = this.getVideoUrl(msg);
    return this.downloadFile(url, 'Video', this.suggestedName(msg, url, 'mp4'));
  }

  // "YYYY-MM-DD-HHmm-<prompt resumido>.<ext>" — date first so downloads sort
  // chronologically when the user keeps the suggested name.
  private suggestedName(msg: ChatMessage, url: string, fallbackExt: string): string {
    const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}`;
    const ext = (url.split('.').pop() || fallbackExt).toLowerCase();

    const skip = new Set(['dibuja', 'dibujame', 'pinta', 'ilustra', 'genera', 'generame', 'crea', 'creame',
      'haz', 'hazme', 'anima', 'una', 'un', 'unos', 'unas', 'el', 'la', 'los', 'las', 'de', 'del', 'en',
      'con', 'para', 'por', 'que', 'al', 'y', 'o', 'u', 'e', 'imagen', 'video', 'vídeo', 'foto',
      'draw', 'generate', 'create', 'make', 'a', 'an', 'the', 'of', 'image', 'picture']);
    const slug = (this.promptFor(msg) || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .trim().split(/\s+/)
      .filter(w => w && !skip.has(w))
      .slice(0, 6)
      .join('-');

    return slug ? `${stamp}-${slug}.${ext}` : `${stamp}.${ext}`;
  }

  // The generation prompt lives in the user bubble of the same task
  private promptFor(msg: ChatMessage): string {
    return this.messages.find(m => m.taskId === msg.taskId && m.role === 'user')?.content ?? '';
  }

  private async downloadFile(url: string, description: string, fileName: string): Promise<void> {
    try {
      const res = await fetch(url);
      const blob = await res.blob();

      // File System Access API (Chrome/Edge): "Save as" dialog so the user
      // picks the destination. Not available in Firefox/Safari → fallback.
      const picker = (window as any).showSaveFilePicker;
      if (picker) {
        try {
          const ext = (fileName.split('.').pop() || 'bin').toLowerCase();
          const kind = description === 'Video' ? 'video' : 'image';
          const mime = blob.type || `${kind}/${ext === 'jpg' ? 'jpeg' : ext}`;
          const handle = await picker.call(window, {
            suggestedName: fileName,
            types: [{ description, accept: { [mime]: ['.' + ext] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return;
        } catch (err: any) {
          if (err?.name === 'AbortError') return; // user cancelled the dialog
          // any other failure → plain download below
        }
      }

      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(objectUrl);
    } catch {
      window.open(url, '_blank');
    }
  }

  openLightbox(msg: ChatMessage): void {
    this.lightboxUrl.set(this.getImageUrl(msg));
  }

  closeLightbox(): void {
    this.lightboxUrl.set(null);
  }

  trackTab(_: number, tab: ChatTab): string { return tab.id; }
  trackMsg(_: number, msg: ChatMessage): string { return msg.id; }
}
