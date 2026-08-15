import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { ApiService } from '../../services/api.service';
import { IconComponent } from '../../components/icon/icon.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, TranslatePipe, IconComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
})
export class LoginComponent {
  private api = inject(ApiService);
  private router = inject(Router);

  token = signal('');
  submitting = signal(false);
  errorKey = signal('');

  submit(): void {
    const token = this.token().trim();
    if (!token || this.submitting()) return;
    this.submitting.set(true);
    this.errorKey.set('');
    this.api.login(token).subscribe({
      next: () => this.router.navigateByUrl('/'),
      error: (err) => {
        this.submitting.set(false);
        if (err?.status === 401) this.errorKey.set('login.invalid');
        else if (err?.status === 429) this.errorKey.set('login.tooMany');
        else this.errorKey.set('login.error');
      },
    });
  }
}
