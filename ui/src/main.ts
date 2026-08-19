// Put Prism on the global eagerly, before any lazy chunk (e.g. chat) loads its
// language components — those files extend a global `Prism` the bundler doesn't
// otherwise provide.
import './app/pipes/prism-setup';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
