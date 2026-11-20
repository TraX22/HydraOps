// One at a time, per key. Tools that read a file and then write it (a note appended to a
// memory file) can be called several times in the same step of a task: without a turn, two
// calls read the same state and both act on it.
//
// The turn is kept inside this process. Calls made at once by one task always are in the
// same process; two services writing the same file at the same instant are not covered.

const turns = new Map<string, Promise<unknown>>();

/** Runs `work` once everything queued earlier under the same key has finished, whether it succeeded or not. */
export function inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const mine = (turns.get(key) ?? Promise.resolve()).then(work, work);
  const settled = mine.catch(() => undefined);
  turns.set(key, settled);
  // The last one out leaves nothing behind.
  void settled.then(() => { if (turns.get(key) === settled) turns.delete(key); });
  return mine;
}
