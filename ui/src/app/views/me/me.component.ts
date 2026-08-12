import { Component, ElementRef, inject, OnInit, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService, UserProfile } from '../../services/api.service';

const EMPTY_PROFILE: UserProfile = {
  name: '', email: '', occupation: '', tools: '', interests: '', notes: '', avatarUrl: null,
};

@Component({
  selector: 'app-me',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './me.component.html',
  styleUrl: './me.component.css',
})
export class MeComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);

  profile = signal<UserProfile>({ ...EMPTY_PROFILE });
  // Solo hay sesión que cerrar cuando se entró con token (acceso por red);
  // desde loopback (escritorio, desarrollo) el botón sobra.
  canLogout = signal(false);
  loading = signal(true);
  saving = signal(false);
  saved = signal(false);
  saveError = signal(false);

  uploading = signal(false);
  uploadError = signal('');

  fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  ngOnInit(): void {
    this.api.getUser().subscribe({
      next: u => { this.profile.set({ ...EMPTY_PROFILE, ...u }); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
    this.api.getAuthStatus().subscribe({
      next: s => this.canLogout.set(s.required && s.authenticated),
      error: () => this.canLogout.set(false),
    });
  }

  logout(): void {
    this.api.logout().subscribe({
      next: () => this.router.navigateByUrl('/login'),
      error: () => this.router.navigateByUrl('/login'),
    });
  }

  setField<K extends keyof UserProfile>(field: K, value: UserProfile[K]): void {
    this.profile.update(p => ({ ...p, [field]: value }));
    this.saved.set(false);
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.saveError.set(false);
    this.api.saveUser(this.profile()).subscribe({
      next: p => {
        this.saving.set(false);
        this.saved.set(true);
        this.profile.set({ ...EMPTY_PROFILE, ...p });
        setTimeout(() => this.saved.set(false), 2500);
      },
      error: () => { this.saving.set(false); this.saveError.set(true); },
    });
  }

  // ── Avatar ──
  openFilePicker(): void {
    this.fileInput()?.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      this.uploadError.set('Max 2MB');
      return;
    }
    this.uploading.set(true);
    this.uploadError.set('');
    this.api.uploadUserAvatar(file).subscribe({
      next: res => {
        this.uploading.set(false);
        this.profile.update(p => ({ ...p, avatarUrl: res.avatarUrl }));
      },
      error: err => {
        this.uploading.set(false);
        this.uploadError.set(err?.error?.error ?? 'Upload failed');
      },
    });
    input.value = '';
  }
}
