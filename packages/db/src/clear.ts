import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../../../db.sqlite3');
const db = new Database(dbPath);

const stmt = db.prepare("DELETE FROM processed_events");
const info = stmt.run();

console.log(`Deleted ${info.changes} rows from processed_events.`);
db.close();
