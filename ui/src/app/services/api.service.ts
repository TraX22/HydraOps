import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Agent {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'working' | 'idle';
  avatarUrl?: string;
  unreadCount?: number;
  workerType?: string;
  llmModel?: string;
}

export interface ChatAttachment {
  name: string;
  mime: string;
  path: string;  // repo-relative, goes into the [ATTACHMENTS] block
  url: string;   // absolute URL for thumbnails / opening in browser
}

export interface UserProfile {
  name: string;
  email: string;
  occupation: string;
  tools: string;
  interests: string;
  notes: string;
  avatarUrl?: string | null;
}

export interface Task {
  id: string;
  prompt: string;
  channel: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed';
  assignedAgent?: string;
  resultRef?: string;
  resultMeta?: Record<string, unknown>;
  isRead?: boolean;
  createdAt: string;
  completedAt?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
  timestamp: string;
  taskId?: string;
  isTyping?: boolean;
  resultMeta?: Record<string, unknown>;
}

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  cronExpression: string;
  assignedAgent: string | null;
  status: 'active' | 'paused';
  lastRunAt?: string;
  createdAt: string;
}

export interface Worker {
  id: string;
  name: string;
  type: string;
  status: 'online' | 'offline';
}

export interface McpConfig {
  mcpServers: Record<string, { switch: 'on' | 'off'; command?: string; args?: string[] }>;
}

export interface NativeAddon {
  name: string;
  description: string;
  enabled: boolean;
  source?: 'native' | 'my_addons';
}

export interface McpServerStatus {
  name: string;
  switch: 'on' | 'off';
  state: 'connecting' | 'connected' | 'failed' | 'timeout' | 'disconnected' | 'off' | 'unknown';
  toolCount: number;
  transport: string;
  error?: string;
}

export interface McpStatusResponse {
  servers: McpServerStatus[];
  lastUpdatedAt: string | null;
  summary: { total: number; connected: number; off: number; errors: number };
}

// Field names follow the API's GET/POST /config contract (camelCase → mapped
// server-side to ENV keys via envMapping)
export interface AppConfig {
  natsUrl: string;
  openaiKey: string;
  anthropicKey: string;
  geminiKey: string;
  groqKey: string;
  xaiKey: string;
  leonardoKey: string;
  openrouterKey: string;
  mistralKey: string;
  deepseekKey: string;
  qwenKey: string;
  kimiKey: string;
  glmKey: string;
  minimaxKey: string;
  localLlmUrl: string;
  localLlmKey: string;
  localLlmModel: string;
  defaultModel: string;
  logLevel: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  type?: 'chat' | 'coder' | 'image' | 'video' | 'audio' | 'embedding';
  isImage?: boolean;
  isVideo?: boolean;
  isCoder?: boolean;
  emoji?: string;
}

export interface StatsData {
  tasks: { total: number; completed: number; failed: number; pending: number };
  avgResponseMs: number;
  totalTokens: number;
  activeAgents: number;
  totalAgents: number;
  workersOnline: number;
  system: { cpuPercent: number; ramUsedBytes: number; ramTotalBytes: number; ramPercent: number };
  perAgent: {
    agentId: string;
    online: boolean;
    total: number;
    completed: number;
    failed: number;
    tokens: number;
    avgMs: number;
  }[];
  tasksPerDay: { date: string; count: number }[];
}

export interface AuthStatus {
  enabled: boolean;        // hay un HYDRA_AUTH_TOKEN configurado en el servidor
  required: boolean;       // ESTA conexión necesita token (false desde loopback)
  authenticated: boolean;  // la sesión actual ya lo presenta
}

export interface VersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  url: string | null;
}

export interface DocsPage {
  slug: string;
  file: string;
  title: Record<string, string>; // idioma → título ("es", "en")
}

export interface DocsManifest {
  pages: DocsPage[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private base = environment.apiUrl;

  constructor(private http: HttpClient) {}

  // ── Auth ──
  login(token: string): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.base}/login`, { token });
  }

  logout(): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.base}/logout`, {});
  }

  getAuthStatus(): Observable<AuthStatus> {
    return this.http.get<AuthStatus>(`${this.base}/auth/status`);
  }

  // ── Version ──
  getVersion(): Observable<VersionInfo> {
    return this.http.get<VersionInfo>(`${this.base}/version`);
  }

  // ── Docs ──
  getDocsManifest(): Observable<DocsManifest> {
    return this.http.get<DocsManifest>(`${this.base}/docs/manifest.json`);
  }

  getDocPage(lang: string, file: string): Observable<string> {
    return this.http.get(`${this.base}/docs/${lang}/${file}`, { responseType: 'text' });
  }

  // ── Agents ──
  getAgents(): Observable<Agent[]> {
    return this.http.get<Agent[]>(`${this.base}/agents`);
  }

  markAgentRead(agentId: string): Observable<void> {
    return this.http.patch<void>(`${this.base}/agents/${agentId}/mark-read`, {});
  }

  uploadAvatar(agentId: string, file: File): Observable<{ success: boolean; avatarUrl: string }> {
    const form = new FormData();
    form.append('avatar', file);
    return this.http.post<{ success: boolean; avatarUrl: string }>(
      `${this.base}/agents/${agentId}/avatar`, form
    );
  }

  getAgentConfig(agentId: string): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(`${this.base}/agents/${agentId}/config`);
  }

  saveAgentConfig(agentId: string, config: { model: string; workerType?: string; graphicEngine?: string; graphicFormat?: string; resolution?: string }): Observable<void> {
    return this.http.post<void>(`${this.base}/agents/${agentId}/config`, config);
  }

  renameAgent(agentId: string, newId: string): Observable<{ success: boolean; id: string }> {
    return this.http.patch<{ success: boolean; id: string }>(`${this.base}/agents/${agentId}/rename`, { newId });
  }

  createAgent(payload: { name: string; workerType: string; model?: string }): Observable<{ id: string; name: string }> {
    return this.http.post<{ id: string; name: string }>(`${this.base}/agents`, payload);
  }

  getAgentFiles(agentId: string): Observable<string[]> {
    return this.http.get<string[]>(`${this.base}/agents/${agentId}/files`);
  }

  getAgentFile(agentId: string, filename: string): Observable<{ content: string }> {
    return this.http.get<{ content: string }>(`${this.base}/agents/${agentId}/files/${filename}`);
  }

  saveAgentFile(agentId: string, filename: string, content: string): Observable<{ success: boolean }> {
    return this.http.put<{ success: boolean }>(`${this.base}/agents/${agentId}/files/${filename}`, { content });
  }

  // ── Tasks / Chat ──
  getTasks(channel: string): Observable<ChatMessage[]> {
    const params = new HttpParams().set('channel', channel);
    return this.http.get<ChatMessage[]>(`${this.base}/tasks`, { params });
  }

  createTask(prompt: string, channel: string): Observable<Task> {
    return this.http.post<Task>(`${this.base}/tasks`, { prompt, channel });
  }

  getTask(id: string): Observable<Task> {
    return this.http.get<Task>(`${this.base}/tasks/${id}`);
  }

  deleteTask(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/tasks/${id}`);
  }

  editTaskPrompt(id: string, prompt: string): Observable<void> {
    return this.http.patch<void>(`${this.base}/tasks/${id}/prompt`, { prompt });
  }

  // ── Config ──
  getConfig(): Observable<AppConfig> {
    const params = new HttpParams().set('t', Date.now().toString());
    return this.http.get<AppConfig>(`${this.base}/config`, { params });
  }

  getModels(): Observable<ModelOption[]> {
    const params = new HttpParams().set('t', Date.now().toString());
    return this.http.get<ModelOption[]>(`${this.base}/config/models`, { params });
  }

  saveConfig(config: Partial<AppConfig>): Observable<void> {
    return this.http.post<void>(`${this.base}/config`, config);
  }

  // ── Crons ──
  getCrons(): Observable<CronJob[]> {
    const params = new HttpParams().set('t', Date.now().toString());
    return this.http.get<CronJob[]>(`${this.base}/crons`, { params });
  }

  createCron(cron: Partial<CronJob>): Observable<CronJob> {
    return this.http.post<CronJob>(`${this.base}/crons`, cron);
  }

  updateCron(id: string, cron: Partial<CronJob>): Observable<CronJob> {
    return this.http.put<CronJob>(`${this.base}/crons/${id}`, cron);
  }

  toggleCron(id: string): Observable<void> {
    return this.http.patch<void>(`${this.base}/crons/${id}/toggle`, {});
  }

  deleteCron(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/crons/${id}`);
  }

  // ── Workers ──
  getWorkers(): Observable<Worker[]> {
    return this.http.get<Worker[]>(`${this.base}/workers`);
  }

  createWorker(name: string): Observable<Worker> {
    return this.http.post<Worker>(`${this.base}/workers`, { name });
  }

  getWorkerLogs(id: string): Observable<string> {
    return this.http.get(`${this.base}/workers/${id}/logs`, { responseType: 'text' });
  }

  // ── Stats ──
  getStats(): Observable<StatsData> {
    return this.http.get<StatsData>(`${this.base}/stats`);
  }

  // ── MCP ──
  getMcpConfig(): Observable<McpConfig> {
    return this.http.get<McpConfig>(`${this.base}/system/mcp`);
  }

  saveMcpConfig(config: McpConfig): Observable<void> {
    return this.http.post<void>(`${this.base}/system/mcp`, config);
  }

  getMcpStatus(): Observable<McpStatusResponse> {
    const params = new HttpParams().set('t', Date.now().toString());
    return this.http.get<McpStatusResponse>(`${this.base}/system/mcp/status`, { params });
  }

  // ── Native addons ──
  getNativeAddons(): Observable<{ addons: NativeAddon[] }> {
    return this.http.get<{ addons: NativeAddon[] }>(`${this.base}/system/addons`);
  }

  saveNativeAddons(state: Record<string, boolean>): Observable<void> {
    return this.http.post<void>(`${this.base}/system/addons`, state);
  }

  // ── User ──
  getUser(): Observable<UserProfile> {
    return this.http.get<UserProfile>(`${this.base}/user`);
  }

  saveUser(profile: Partial<UserProfile>): Observable<UserProfile> {
    return this.http.post<UserProfile>(`${this.base}/user`, profile);
  }

  uploadUserAvatar(file: File): Observable<{ success: boolean; avatarUrl: string }> {
    const form = new FormData();
    form.append('avatar', file);
    return this.http.post<{ success: boolean; avatarUrl: string }>(`${this.base}/user/avatar`, form);
  }

  uploadChatFile(file: File): Observable<ChatAttachment> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<ChatAttachment>(`${this.base}/upload`, form);
  }

  // ── Storage URL ──
  storageUrl(path: string): string {
    return `${this.base}/storage/${path}`;
  }
}
