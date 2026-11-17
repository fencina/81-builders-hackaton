import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';

// Match the coordinator's database configuration; leave Mastra memory and the
// separate Turno admin tables alone, even when they share a database file.
const url = process.env.SHIFTS_DATABASE_URL || `file:${resolve('.data/shifts.db')}`;
if (!process.env.SHIFTS_DATABASE_URL) mkdirSync(resolve('.data'), { recursive: true });
const db = createClient({ url, authToken: process.env.SHIFTS_DATABASE_AUTH_TOKEN });
const tables = [
  'shift_notifications',
  'shift_request_codes',
  'shift_change_requests',
  'whatsapp_messages',
  'shift_conversations',
  'outreach',
  'shifts',
  'employees',
];
try {
  const existing = new Set((await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(row => row.name));
  const selected = tables.filter(table => existing.has(table));
  if (selected.length) await db.batch(selected.map(table => `DELETE FROM "${table}"`), 'write');
  console.log('Shift coordinator database reset: employees, shifts, outreach, conversations, requests, notifications, and processed messages cleared.');
  console.log('Add demo employees and shifts before restarting the agent. Mastra chat history and Turno admin data are unchanged.');
} finally {
  db.close();
}
