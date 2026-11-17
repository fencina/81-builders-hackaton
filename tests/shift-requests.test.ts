import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import {
  ShiftRequests,
  requestTables,
} from '../src/mastra/lib/shift-requests.ts';

async function fixture(t: { after: (fn: () => void) => void }) {
  const db = createClient({ url: ':memory:' });
  t.after(() => db.close());
  await db.executeMultiple(`${requestTables}
    CREATE TABLE employees(id TEXT PRIMARY KEY, phone_number TEXT, name TEXT);
    CREATE TABLE shifts(id TEXT PRIMARY KEY,start_at TEXT,end_at TEXT,status TEXT,employee_id TEXT);
    CREATE TABLE shift_conversations(employee_id TEXT PRIMARY KEY,offer_date TEXT,status TEXT);
    CREATE TABLE whatsapp_messages(id TEXT PRIMARY KEY);
    INSERT INTO employees VALUES('employee','+819012345678','Alex');
    INSERT INTO shift_conversations VALUES('employee','2099-01-01','active');
    INSERT INTO shifts VALUES('urgent','2099-01-01T10:00:00+09:00','2099-01-01T18:00:00+09:00','available',NULL);
    INSERT INTO shifts VALUES('original','2099-01-01T02:00:00Z','2099-01-01T10:00:00Z','not available','employee');
  `);
  const service = new ShiftRequests(db, 'Asia/Tokyo');
  const create = () =>
    service.create('employee', 'urgent', [], '+819099999999');
  const owner = async (id: string) =>
    (
      await db.execute({
        sql: 'SELECT employee_id FROM shifts WHERE id=?',
        args: [id],
      })
    ).rows[0].employee_id;
  const messages = async () =>
    (
      await db.execute('SELECT message FROM shift_notifications ORDER BY rowid')
    ).rows.map((r) => String(r.message));
  return { db, service, create, owner, messages };
}

test('overlap requests include employee, both shifts, timezone and decision commands without assigning', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  assert.equal(await f.owner('urgent'), null);
  assert.equal(await f.owner('original'), 'employee');
  const text = (await f.messages())[0];
  for (const value of [
    'Alex',
    'urgent',
    'original',
    'Asia/Tokyo',
    'APPROVE ' + id,
    'DENY ' + id,
  ])
    assert.ok(text.includes(value), value);
  assert.equal(await f.create(), id);
});
test('approval atomically swaps assignments and notifies both parties; replay cannot undo it', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  assert.equal(
    await f.service.decide(id, 'manager', '819099999999', true, 'msg1'),
    true,
  );
  assert.equal(await f.owner('urgent'), 'employee');
  assert.equal(await f.owner('original'), null);
  assert.equal(
    await f.service.decide(id, 'manager', '819099999999', false, 'msg1'),
    false,
  );
  assert.equal(
    await f.service.decide(id, 'manager', '819099999999', false, 'msg2'),
    false,
  );
  assert.ok(
    (await f.messages()).some((s) => s.includes('Your request was approved')),
  );
});
test('denial preserves assignments, persists across service instances, and employee yes keeps originals', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.service.decide(id, 'manager', '819099999999', false, 'deny');
  assert.equal(await f.owner('urgent'), null);
  assert.equal(await f.owner('original'), 'employee');
  assert.ok(
    (await f.messages()).some((s) => s.includes('even if they overlap')),
  );
  const restarted = new ShiftRequests(f.db, 'Asia/Tokyo');
  assert.equal(
    (await restarted.pending('employee'))?.status,
    'employee_pending',
  );
  await restarted.decide(id, 'employee', '819012345678', true, 'yes');
  assert.equal(await f.owner('urgent'), 'employee');
  assert.equal(await f.owner('original'), 'employee');
  assert.ok(
    (await f.messages()).some((s) =>
      s.includes('Employee explicitly accepted after denial'),
    ),
  );
});
test('employee no thanks them and informs manager without changing assignments', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.service.decide(id, 'manager', '819099999999', false, 'deny');
  await f.service.decide(id, 'employee', '819012345678', false, 'no');
  assert.equal(await f.owner('urgent'), null);
  assert.equal(await f.owner('original'), 'employee');
  assert.equal(await f.service.pending('employee'), undefined);
  assert.ok(
    (await f.messages()).some((s) => s.includes('Thank you for your time')),
  );
  assert.ok(
    (await f.messages()).some((s) => s.includes('declined the urgent shift')),
  );
});
test('unknown senders and employees cannot approve; employee cannot skip manager decision', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  assert.equal(
    await f.service.decide(id, 'manager', '819012345678', true, 'bad1'),
    false,
  );
  assert.equal(
    await f.service.decide(id, 'manager', '1234', true, 'bad2'),
    false,
  );
  assert.equal(
    await f.service.decide(id, 'employee', '819012345678', true, 'bad3'),
    false,
  );
  assert.equal(await f.owner('urgent'), null);
});
for (const change of [
  'filled',
  'release changed',
  'urgent changed',
  'new overlap',
])
  test(`approval preserves schedule if ${change}`, async (t) => {
    const f = await fixture(t);
    const id = await f.create();
    if (change === 'filled')
      await f.db.execute(
        "UPDATE shifts SET employee_id='other',status='not available' WHERE id='urgent'",
      );
    if (change === 'release changed')
      await f.db.execute(
        "UPDATE shifts SET employee_id='other' WHERE id='original'",
      );
    if (change === 'urgent changed')
      await f.db.execute(
        "UPDATE shifts SET end_at='2099-01-01T20:00:00+09:00' WHERE id='urgent'",
      );
    if (change === 'new overlap')
      await f.db.execute(
        "INSERT INTO shifts VALUES('new','2099-01-01T10:00:00+09:00','2099-01-01T11:00:00+09:00','not available','employee')",
      );
    await f.service.decide(id, 'manager', '819099999999', true, 'approve');
    assert.equal(await f.owner('urgent'), change === 'filled' ? 'other' : null);
    assert.equal(
      await f.owner('original'),
      change === 'release changed' ? 'other' : 'employee',
    );
    assert.ok((await f.messages()).some((s) => s.includes('schedule changed')));
  });
test('a non-overlapping future shift can be explicitly requested for release', async (t) => {
  const f = await fixture(t);
  await f.db.execute(
    "UPDATE shifts SET start_at='2099-01-04T10:00:00+09:00',end_at='2099-01-04T18:00:00+09:00' WHERE id='original'",
  );
  const id = await f.service.create(
    'employee',
    'urgent',
    ['original'],
    '819099999999',
  );
  await f.service.decide(id, 'manager', '819099999999', true, 'approve');
  assert.equal(await f.owner('original'), null);
  assert.equal(await f.owner('urgent'), 'employee');
});
test('all overlapping shifts must be released, including different ISO offsets; adjacent times do not overlap', async (t) => {
  const f = await fixture(t);
  await f.db.execute(
    "INSERT INTO shifts VALUES('second','2099-01-01T17:00:00+09:00','2099-01-01T19:00:00+09:00','not available','employee')",
  );
  await f.db.execute(
    "INSERT INTO shifts VALUES('adjacent','2099-01-01T18:00:00+09:00','2099-01-01T20:00:00+09:00','not available','employee')",
  );
  const id = await f.create();
  await f.service.decide(id, 'manager', '819099999999', true, 'approve');
  assert.equal(await f.owner('original'), null);
  assert.equal(await f.owner('second'), null);
  assert.equal(await f.owner('adjacent'), 'employee');
});
test('failed delivery retries after restart without replaying the schedule change', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.service.decide(id, 'manager', '819099999999', true, 'approve');
  await assert.rejects(
    f.service.flush(async () => {
      throw new Error('offline');
    }),
    /offline/,
  );
  const sent: string[] = [];
  await new ShiftRequests(f.db, 'Asia/Tokyo').flush(async (_phone, text) => {
    sent.push(text);
  });
  assert.equal(sent.length, 4);
  assert.equal(await f.owner('original'), null);
  await f.service.flush(async () => {
    assert.fail('already delivered');
  });
});
