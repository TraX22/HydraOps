import { Injectable, signal, inject } from '@angular/core';
import { ApiService, ChatAttachment, ChatMessage, Task } from './api.service';
import { Subscription, interval, switchMap, catchError, EMPTY } from 'rxjs';

export interface ChatTab {
  id: string;
  label: string;
  avatarUrl?: string;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private api = inject(ApiService);

  readonly messagesByChannel = signal<Record<string, ChatMessage[]>>({ main: [] });
  readonly activeTab = signal<string>('main');
  readonly tabs = signal<ChatTab[]>(this.loadTabs());
  readonly sending = signal(false);

  private pollSub?: Subscription;
  private taskPollSubs = new Map<string, Subscription>();

  // Unsent text and attachments, per chat. The chat view is destroyed when
  // the user navigates elsewhere (Agents, Config…), so they live here; the
  // text also survives a restart.
  private drafts: Record<string, string> = this.loadDrafts();
  private pendingAttachments = new Map<string, ChatAttachment[]>();

  getDraft(channel: string): string {
    return this.drafts[channel] ?? '';
  }

  setDraft(channel: string, text: string): void {
    if (text) this.drafts[channel] = text;
    else delete this.drafts[channel];
    try { localStorage.setItem('hydra_chat_drafts', JSON.stringify(this.drafts)); } catch { /* storage unavailable */ }
  }

  getPendingAttachments(channel: string): ChatAttachment[] {
    return this.pendingAttachments.get(channel) ?? [];
  }

  setPendingAttachments(channel: string, atts: ChatAttachment[]): void {
    if (atts.length) this.pendingAttachments.set(channel, atts);
    else this.pendingAttachments.delete(channel);
  }

  get currentMessages(): ChatMessage[] {
    return this.messagesByChannel()[this.activeTab()] ?? [];
  }

  switchTab(tabId: string): void {
    this.activeTab.set(tabId);
    this.fetchHistory(tabId);
    this.startPolling(tabId);
    this.markRead(tabId);
  }

  // Viewing an agent's chat marks ALL its completed tasks as read (cron and
  // Telegram results included — they're born unread and are what keeps the
  // agent's dot green). The endpoint clears by agent, beyond the 24h window
  // the chat displays. 'main' has no single owning agent, so it's skipped.
  private markRead(channel: string): void {
    if (channel === 'main') return;
    this.api.markAgentRead(channel).subscribe({ error: () => { /* best-effort */ } });
  }

  openAgentTab(agentId: string, agentName: string, avatarUrl?: string): void {
    const currentTabs = this.tabs();
    if (!currentTabs.find(t => t.id === agentId)) {
      const updated = [...currentTabs, { id: agentId, label: agentName, avatarUrl }];
      this.tabs.set(updated);
      this.saveTabs(updated);
    }
    this.switchTab(agentId);
  }

  closeTab(tabId: string): void {
    const updated = this.tabs().filter(t => t.id !== tabId);
    this.tabs.set(updated);
    this.saveTabs(updated);
    if (this.activeTab() === tabId) {
      this.switchTab('main');
    }
  }

  fetchHistory(channel: string): void {
    this.api.getTasks(channel).subscribe({
      next: messages => {
        this.messagesByChannel.update(m => ({ ...m, [channel]: messages }));
      },
    });
  }

  sendMessage(prompt: string, channel: string): void {
    if (!prompt.trim()) return;
    this.sending.set(true);

    const userMsg: ChatMessage = {
      id: 'temp-' + Date.now(),
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    this.messagesByChannel.update(m => ({
      ...m,
      [channel]: [...(m[channel] ?? []), userMsg],
    }));

    this.api.createTask(prompt, channel).subscribe({
      next: (task: Task) => {
        this.sending.set(false);
        const typingMsg: ChatMessage = {
          id: 'typing-' + task.id,
          role: 'assistant',
          content: '',
          taskId: task.id,
          isTyping: true,
          timestamp: new Date().toISOString(),
        };
        this.messagesByChannel.update(m => ({
          ...m,
          [channel]: [...(m[channel] ?? []), typingMsg],
        }));
        this.pollTaskCompletion(task.id, channel);
      },
      error: () => this.sending.set(false),
    });
  }

  deleteMessage(taskId: string, channel: string): void {
    this.api.deleteTask(taskId).subscribe(() => this.fetchHistory(channel));
  }

  editMessage(taskId: string, newPrompt: string, channel: string): void {
    this.api.editTaskPrompt(taskId, newPrompt).subscribe(() => this.fetchHistory(channel));
  }

  startPolling(channel: string): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(4000)
      .pipe(
        // A failed poll (API restarting, network blip) must not blank the
        // chat: skip the tick and keep what is on screen.
        switchMap(() => this.api.getTasks(channel).pipe(catchError(() => EMPTY))),
      )
      .subscribe(messages => {
        // A new reply arrived while the user is looking at this chat → it's read.
        const prev = this.messagesByChannel()[channel]?.length ?? 0;
        this.messagesByChannel.update(m => ({ ...m, [channel]: messages }));
        if (messages.length > prev) this.markRead(channel);
      });
  }

  stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.taskPollSubs.forEach(s => s.unsubscribe());
    this.taskPollSubs.clear();
  }

  private pollTaskCompletion(taskId: string, channel: string): void {
    const sub = interval(2000)
      .pipe(
        switchMap(() => this.api.getTask(taskId).pipe(catchError(() => EMPTY))),
      )
      .subscribe(task => {
        if (task.status === 'completed' || task.status === 'failed') {
          sub.unsubscribe();
          this.taskPollSubs.delete(taskId);
          this.fetchHistory(channel);
        }
      });
    this.taskPollSubs.set(taskId, sub);
  }

  private loadDrafts(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem('hydra_chat_drafts') ?? '{}');
    } catch {
      return {};
    }
  }

  private loadTabs(): ChatTab[] {
    try {
      return JSON.parse(localStorage.getItem('hydra_chat_tabs') ?? '[]');
    } catch {
      return [];
    }
  }

  private saveTabs(tabs: ChatTab[]): void {
    localStorage.setItem('hydra_chat_tabs', JSON.stringify(tabs));
  }
}
