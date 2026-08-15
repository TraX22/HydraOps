import { Component, inject, OnInit, OnDestroy, signal, viewChild, ElementRef, afterNextRender } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { ChatService, ChatTab } from '../../services/chat.service';
import { AgentsService } from '../../services/agents.service';
import { ApiService, ChatAttachment, ChatMessage } from '../../services/api.service';
import { DatePipe } from '@angular/common';
import { MarkdownPipe } from '../../pipes/markdown.pipe';
import { IconComponent } from '../../components/icon/icon.component';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, TranslatePipe, MarkdownPipe, DatePipe, IconComponent],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css',
})
export class ChatComponent implements OnInit, OnDestroy {
  chat = inject(ChatService);
  agents = inject(AgentsService);
  private api = inject(ApiService);
  private router = inject(Router);

  inputValue = signal('');
  editingMsgId = signal<string | null>(null);
  editingText = signal('');
  copiedMsgId = signal<string | null>(null);

  messagesEnd = viewChild<ElementRef>('messagesEnd');

  ngOnInit(): void {
    this.chat.fetchHistory(this.chat.activeTab());
    this.chat.startPolling(this.chat.activeTab());
  }

  ngOnDestroy(): void {
    this.chat.stopPolling();
  }

  get messages(): ChatMessage[] {
    return this.chat.messagesByChannel()[this.chat.activeTab()] ?? [];
  }

  send(): void {
    const val = this.inputValue().trim();
    const atts = this.attachments();
    if ((!val && atts.length === 0) || this.uploadingCount() > 0) return;
    let prompt = val;
    if (atts.length > 0) {
      // Marker block parsed by the workers (buildUserMessage in @hydraops/llm)
      prompt = `${val}\n\n[ATTACHMENTS]\n${atts.map(a => `- ${a.path} (${a.mime})`).join('\n')}`.trim();
    }
    this.chat.sendMessage(prompt, this.chat.activeTab());
    this.inputValue.set('');
    this.attachments.set([]);
    this.scrollToBottom();
  }

  // ── Ficha del agente desde el chat ──
  // La API manda agentId en cada mensaje de agente; el nombre y la pestaña
  // activa quedan como red de seguridad para históricos antiguos.
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
        this.attachError.set(`${file.name}: máx 20MB`);
        continue;
      }
      this.uploadingCount.update(n => n + 1);
      this.api.uploadChatFile(file).subscribe({
        next: att => {
          this.uploadingCount.update(n => n - 1);
          this.attachments.update(a => [...a, att]);
        },
        error: err => {
          this.uploadingCount.update(n => n - 1);
          this.attachError.set(err?.error?.error ?? `${file.name}: upload failed`);
        },
      });
    }
  }

  removeAttachment(att: ChatAttachment): void {
    this.attachments.update(a => a.filter(x => x !== att));
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.send();
    }
  }

  switchTab(tabId: string): void {
    this.chat.switchTab(tabId);
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

  scrollToBottom(): void {
    setTimeout(() => {
      this.messagesEnd()?.nativeElement.scrollIntoView({ behavior: 'smooth' });
    }, 100);
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
