import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import {
  ShiftRequests,
  requestTables,
  parseManagerCommand,
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
  const code = String(
    (
      await f.db.execute({
        sql: 'SELECT code FROM shift_request_codes WHERE request_id=?',
        args: [id],
      })
    ).rows[0].code,
  );
  assert.match(code, /^[A-Z0-9]{4}$/);
  assert.ok(!text.includes(id));
  for (const value of [
    'Alex',
    'urgent',
    'original',
    'Asia/Tokyo',
    'APPROVE ' + code,
    'DENY ' + code,
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

test('manager commands accept four-character codes case-insensitively and legacy UUIDs', () => {
  assert.deepEqual(parseManagerCommand(' approve a7b2 '), {
    id: 'A7B2',
    approved: true,
  });
  assert.deepEqual(parseManagerCommand('DENY 0Z9X'), {
    id: '0Z9X',
    approved: false,
  });
  const id = '12345678-abcd-4321-abcd-123456789abc';
  assert.deepEqual(parseManagerCommand(`APPROVE ${id}`), {
    id,
    approved: true,
  });
  for (const text of [
    'APPROVE ABC',
    'DENY ABCDE',
    'APPROVE A!B2',
    'please approve A7B2',
    'APPROVE A7B2 extra',
  ])
    assert.equal(parseManagerCommand(text), null);
});

test('short code approval survives a restart and retains manager authorization and replay protection', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  const code = String(
    (
      await f.db.execute({
        sql: 'SELECT code FROM shift_request_codes WHERE request_id=?',
        args: [id],
      })
    ).rows[0].code,
  );
  const restarted = new ShiftRequests(f.db, 'Asia/Tokyo');
  assert.equal(
    await restarted.decide(code, 'manager', '1234', true, 'unauthorized'),
    false,
  );
  assert.equal(
    await restarted.decide('!!!!', 'manager', '819099999999', true, 'unknown'),
    false,
  );
  assert.equal(
    await restarted.decide(
      code.toLowerCase(),
      'manager',
      '819099999999',
      true,
      'approve',
    ),
    true,
  );
  assert.equal(await f.owner('urgent'), 'employee');
  assert.equal(await f.owner('original'), null);
  assert.equal(
    await restarted.decide(code, 'manager', '819099999999', true, 'repeat'),
    false,
  );
  const notifications = await f.messages();
  assert.ok(notifications.some((s) => s.includes(`request ${code} approved`)));
  assert.ok(notifications.every((s) => !s.includes(id)));
});

test('short code denial keeps employee replies using the internal request ID', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  const code = String(
    (
      await f.db.execute({
        sql: 'SELECT code FROM shift_request_codes WHERE request_id=?',
        args: [id],
      })
    ).rows[0].code,
  );
  assert.equal(
    await f.service.decide(code, 'manager', '819099999999', false, 'deny'),
    true,
  );
  assert.equal((await f.service.pending('employee'))?.id, id);
  assert.equal(
    await f.service.decide(id, 'employee', '819012345678', false, 'no'),
    true,
  );
  assert.equal(await f.owner('urgent'), null);
  assert.ok(
    (await f.messages()).some((s) => s.includes(`Request ${code} denied`)),
  );
});

test('codes remain unique across completed requests', async (t) => {
  const f = await fixture(t);
  const codes = new Set();
  for (let i = 0; i < 20; i++) {
    const id = await f.create();
    const code = String(
      (
        await f.db.execute({
          sql: 'SELECT code FROM shift_request_codes WHERE request_id=?',
          args: [id],
        })
      ).rows[0].code,
    );
    assert.match(code, /^[A-Z0-9]{4}$/);
    assert.ok(!codes.has(code));
    codes.add(code);
    await f.service.decide(code, 'manager', '819099999999', false, `deny-${i}`);
    await f.service.decide(id, 'employee', '819012345678', false, `no-${i}`);
  }
  assert.equal(codes.size, 20);
});

test('legacy requests without a code can still be decided with their UUID', async (t) => {
  const f = await fixture(t);
  const id = await f.create();
  await f.db.execute({
    sql: 'DELETE FROM shift_request_codes WHERE request_id=?',
    args: [id],
  });
  assert.equal(
    await f.service.decide(id, 'manager', '819099999999', true, 'legacy'),
    true,
  );
  assert.equal(await f.owner('urgent'), 'employee');
});
