import { Injectable } from '@angular/core';
import { ProjectChange } from './api.service';

/** A file of a project open in the editor of its tab. */
export interface OpenFile {
  path: string;
  /** The text as it was last read from, or saved to, the agent's copy. */
  text: string;
  /** The fingerprint of that text: a save says which text it started from. */
  hash: string;
  state: ProjectChange['state'] | null;
  /** Lines that differ from the user's commit. */
  changedLines: number[];
  /** Where the file is in the user's own folder. */
  source: string;
  loading: boolean;
  /** Why it cannot be opened (a code the view puts into words). */
  error?: string;
  /** Edited here and not saved yet. */
  dirty: boolean;
  /** The unsaved text, kept while the view is away (the editor itself holds it while it is on screen). */
  draft?: string;
  /** The file changed in the copy while there were unsaved edits here. */
  stale: boolean;
  saving: boolean;
  saveError?: string;
}

/**
 * The files open in each project's tab, and which one is in front. They live here, not in
 * the view, so that going to another section and coming back (or switching project) keeps
 * the open files and what was typed and not saved. A page reload starts clean.
 */
@Injectable({ providedIn: 'root' })
export class ProjectFilesService {
  private readonly byProject = new Map<string, { files: OpenFile[]; tab: string }>();

  load(projectId: string): { files: OpenFile[]; tab: string } {
    return this.byProject.get(projectId) ?? { files: [], tab: 'changes' };
  }

  store(projectId: string, files: OpenFile[], tab: string): void {
    if (files.length) this.byProject.set(projectId, { files, tab });
    else this.byProject.delete(projectId);
  }

  forget(projectId: string): void {
    this.byProject.delete(projectId);
  }
}
