import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';

const timezone = process.env.BUSINESS_TIMEZONE || 'Asia/Tokyo';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
function parts(date) {
  return Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
}
const today = parts(new Date());
const tomorrow = new Date(
  Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) + 1),
)
  .toISOString()
  .slice(0, 10);
// Convert a business-local wall time to an ISO instant without assuming a fixed
// UTC offset, so tomorrow's shifts remain valid across timezone/DST changes.
function at(hour) {
  const target = Date.parse(
    `${tomorrow}T${String(hour).padStart(2, '0')}:00:00Z`,
  );
  let instant = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(new Date(instant));
    const wall = Date.parse(
      `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
    );
    if (wall === target) return new Date(instant).toISOString();
    instant += target - wall;
  }
  throw new Error(`Cannot resolve demo time in ${timezone}`);
}
const url =
  process.env.SHIFTS_DATABASE_URL || `file:${resolve('.data/shifts.db')}`;
if (!process.env.SHIFTS_DATABASE_URL)
  mkdirSync(resolve('.data'), { recursive: true });
const db = createClient({
  url,
  authToken: process.env.SHIFTS_DATABASE_AUTH_TOKEN,
});
try {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, phone_number TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available', employee_id TEXT REFERENCES employees(id)
    );
  `);
  let employee;
  if (process.env.DEMO_EMPLOYEE_ID) {
    employee = (
      await db.execute({
        sql: 'SELECT * FROM employees WHERE id=?',
        args: [process.env.DEMO_EMPLOYEE_ID],
      })
    ).rows[0];
    if (!employee)
      throw new Error(
        'DEMO_EMPLOYEE_ID does not match an employee in this database.',
      );
  } else if (process.env.DEMO_EMPLOYEE_PHONE) {
    const phone = process.env.DEMO_EMPLOYEE_PHONE.replace(/\D/g, '');
    if (!/^\d{7,15}$/.test(phone))
      throw new Error(
        'DEMO_EMPLOYEE_PHONE must include country code and a valid phone number.',
      );
    const employees = (await db.execute('SELECT * FROM employees ORDER BY id'))
      .rows;
    employee = employees.find(
      (e) => String(e.phone_number).replace(/\D/g, '') === phone,
    );
    if (!employee) {
      employee = {
        id: `demo-${randomUUID()}`,
        name: process.env.DEMO_EMPLOYEE_NAME || 'Demo Employee',
        phone_number: phone,
      };
      await db.execute({
        sql: 'INSERT INTO employees(id,phone_number,name) VALUES(?,?,?)',
        args: [employee.id, employee.phone_number, employee.name],
      });
    }
  } else
    employee = (await db.execute('SELECT * FROM employees ORDER BY id LIMIT 1'))
      .rows[0];
  if (!employee)
    throw new Error(
      'No employees found. Set DEMO_EMPLOYEE_PHONE in .env to your test WhatsApp number (including country code), then rerun npm run db:seed.',
    );
  const urgentId = `demo-${tomorrow}-urgent`;
  const assignedId = `demo-${tomorrow}-assigned`;
  await db.batch(
    [
      {
        sql: "INSERT OR IGNORE INTO shifts VALUES(?,?,?,'available',NULL)",
        args: [urgentId, at(9), at(13)],
      },
      {
        sql: "INSERT OR IGNORE INTO shifts VALUES(?,?,?,'not available',?)",
        args: [assignedId, at(11), at(15), employee.id],
      },
    ],
    'write',
  );
  console.log(`Demo ready for ${tomorrow} (${timezone}).`);
  console.log(`Employee: ${employee.name} (${employee.id})`);
  console.log(`Urgent shift: ${urgentId}, 09:00–13:00`);
  console.log(`Overlapping assignment: ${assignedId}, 11:00–15:00`);
  console.log(
    'Existing demo rows are preserved. To replay a completed demo, run npm run db:reset, then npm run db:seed with DEMO_EMPLOYEE_PHONE configured.',
  );
} finally {
  db.close();
}
