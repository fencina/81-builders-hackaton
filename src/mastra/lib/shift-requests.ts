import { randomInt, randomUUID } from 'node:crypto';
import type { Client, Transaction } from '@libsql/client';
import type { Shift } from './database';

type Request = {
  id: string;
  employee_id: string;
  urgent_id: string;
  urgent_shift: string;
  release_shifts: string;
  manager_phone: string;
  status: string;
};
type SQL = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
export const requestTables = `
  CREATE TABLE IF NOT EXISTS shift_change_requests (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, urgent_id TEXT NOT NULL, urgent_shift TEXT NOT NULL,
    release_shifts TEXT NOT NULL, manager_phone TEXT NOT NULL, status TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shift_request_codes (
    code TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_change ON shift_change_requests(employee_id)
    WHERE status IN ('manager_pending', 'employee_pending');
  CREATE TABLE IF NOT EXISTS shift_notifications (
    id TEXT PRIMARY KEY, phone TEXT NOT NULL, message TEXT NOT NULL, sent_at TEXT
  );
`;

// Full IDs remain accepted for manager messages sent before short codes existed.
export function parseManagerCommand(message: string) {
  const match = message
    .trim()
    .match(
      /^(APPROVE|DENY)\s+([a-z0-9]{4}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
    );
  return match
    ? {
        id:
          match[2].length === 4
            ? match[2].toUpperCase()
            : match[2].toLowerCase(),
        approved: match[1].toUpperCase() === 'APPROVE',
      }
    : null;
}

// Approval state and schedule updates belong to one business transaction. WhatsApp
// delivery is retried separately; a delivery failure must never roll back a decision.
export class ShiftRequests {
  private db: Client;
  private timezone: string;
  constructor(db: Client, timezone: string) {
    this.db = db;
    this.timezone = timezone;
  }
  async pending(employeeId: string) {
    return (
      await this.db.execute({
        sql: "SELECT * FROM shift_change_requests WHERE employee_id=? AND status IN ('manager_pending','employee_pending')",
        args: [employeeId],
      })
    ).rows[0] as unknown as Request | undefined;
  }
  async assigned(employeeId: string, sql: SQL = this.db) {
    return (
      await sql.execute({
        sql: 'SELECT * FROM shifts WHERE employee_id=?',
        args: [employeeId],
      })
    ).rows as unknown as Shift[];
  }
  overlaps(a: Shift, b: Shift) {
    return (
      Date.parse(a.start_at) < Date.parse(b.end_at) &&
      Date.parse(b.start_at) < Date.parse(a.end_at)
    );
  }
  private label(shift: Shift) {
    const fmt = (d: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: this.timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(d));
    return `${shift.id}: ${fmt(shift.start_at)} – ${fmt(shift.end_at)} (${this.timezone})`;
  }
  private async queue(sql: SQL, phone: string, message: string) {
    await sql.execute({
      sql: 'INSERT INTO shift_notifications(id,phone,message) VALUES(?,?,?)',
      args: [randomUUID(), phone, message],
    });
  }
  private async createCode(sql: SQL, requestId: string) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = randomInt(36 ** 4)
        .toString(36)
        .padStart(4, '0')
        .toUpperCase();
      const result = await sql.execute({
        sql: 'INSERT OR IGNORE INTO shift_request_codes(code,request_id) VALUES(?,?)',
        args: [code, requestId],
      });
      if (result.rowsAffected === 1) return code;
    }
    throw new Error(
      'Could not allocate a unique four-character approval code. Please try again.',
    );
  }
  private async shift(sql: SQL, id: string) {
    return (
      await sql.execute({ sql: 'SELECT * FROM shifts WHERE id=?', args: [id] })
    ).rows[0] as unknown as Shift | undefined;
  }
  private async employee(sql: SQL, id: string) {
    const row = (
      await sql.execute({
        sql: 'SELECT * FROM employees WHERE id=?',
        args: [id],
      })
    ).rows[0];
    if (!row) throw new Error('Employee not found');
    return { name: String(row.name), phone: String(row.phone_number) };
  }
  async create(
    employeeId: string,
    urgentId: string,
    releaseIds: string[],
    managerPhone: string,
  ) {
    if (!managerPhone.replace(/\D/g, ''))
      throw new Error(
        'Set SHIFT_MANAGER_PHONE before requesting a shift change',
      );
    const tx = await this.db.transaction('write');
    try {
      const existing = (
        await tx.execute({
          sql: "SELECT id FROM shift_change_requests WHERE employee_id=? AND status IN ('manager_pending','employee_pending')",
          args: [employeeId],
        })
      ).rows[0];
      if (existing) {
        await tx.rollback();
        return String(existing.id);
      }
      const urgent = await this.shift(tx, urgentId);
      if (
        !urgent ||
        urgent.employee_id ||
        urgent.status !== 'available' ||
        Date.parse(urgent.start_at) <= Date.now()
      )
        throw new Error('Urgent shift is no longer available');
      const assigned = await this.assigned(employeeId, tx);
      const ids = new Set([
        ...releaseIds,
        ...assigned.filter((s) => this.overlaps(s, urgent)).map((s) => s.id),
      ]);
      const release = assigned.filter((s) => ids.has(s.id));
      if (
        !ids.size ||
        release.length !== ids.size ||
        release.some((s) => Date.parse(s.start_at) <= Date.now())
      )
        throw new Error('Select future shifts assigned to this employee');
      const id = randomUUID();
      const employee = await this.employee(tx, employeeId);
      const code = await this.createCode(tx, id);
      await tx.execute({
        sql: 'INSERT INTO shift_change_requests VALUES(?,?,?,?,?,?,?)',
        args: [
          id,
          employeeId,
          urgentId,
          JSON.stringify(urgent),
          JSON.stringify(release),
          managerPhone,
          'manager_pending',
        ],
      });
      await this.queue(
        tx,
        managerPhone,
        `Shift change request ${code}\nUrgent shift: ${this.label(urgent)}\nEmployee: ${employee.name} (${employeeId})\nRequests removal from:\n${release.map((s) => this.label(s)).join('\n')}\nApprove or deny this request. Reply APPROVE ${code} or DENY ${code}.`,
      );
      await this.queue(
        tx,
        employee.phone,
        `Your request to leave ${release.map((s) => this.label(s)).join('; ')} and take ${this.label(urgent)} has been sent to your manager. No assignments have changed yet.`,
      );
      await tx.commit();
      return id;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  async decide(
    id: string,
    actor: 'manager' | 'employee',
    phone: string,
    yes: boolean,
    messageId: string,
  ) {
    const tx = await this.db.transaction('write');
    try {
      if (
        (
          await tx.execute({
            sql: 'SELECT id FROM whatsapp_messages WHERE id=?',
            args: [messageId],
          })
        ).rows.length
      ) {
        await tx.rollback();
        return false;
      }
      if (/^[a-z0-9]{4}$/i.test(id)) {
        const mapping = (
          await tx.execute({
            sql: 'SELECT request_id FROM shift_request_codes WHERE code=?',
            args: [id.toUpperCase()],
          })
        ).rows[0];
        if (!mapping) {
          await tx.rollback();
          return false;
        }
        id = String(mapping.request_id);
      }
      const request = (
        await tx.execute({
          sql: 'SELECT * FROM shift_change_requests WHERE id=?',
          args: [id],
        })
      ).rows[0] as unknown as Request | undefined;
      if (!request) {
        await tx.rollback();
        return false;
      }
      const codeRow = (
        await tx.execute({
          sql: 'SELECT code FROM shift_request_codes WHERE request_id=?',
          args: [id],
        })
      ).rows[0];
      const displayId = codeRow ? String(codeRow.code) : id;
      const employee = await this.employee(tx, request.employee_id);
      const normalize = (s: string) => {
        const d = s.replace(/\D/g, '');
        return /^549\d{10}$/.test(d) ? `54${d.slice(3)}` : d;
      };
      if (
        normalize(phone) !==
          normalize(
            actor === 'manager' ? request.manager_phone : employee.phone,
          ) ||
        request.status !==
          (actor === 'manager' ? 'manager_pending' : 'employee_pending')
      ) {
        await tx.rollback();
        return false;
      }
      const urgent = await this.shift(tx, request.urgent_id);
      const requestedUrgent = JSON.parse(request.urgent_shift) as Shift;
      const release = JSON.parse(request.release_shifts) as Shift[];
      let status: string;
      if (actor === 'manager' && !yes) {
        status = 'employee_pending';
        await this.queue(
          tx,
          employee.phone,
          `Your manager denied your request to leave ${release.map((s) => this.label(s)).join('; ')}. Your assignments have not changed. Do you still want to take the urgent shift ${urgent ? this.label(urgent) : request.urgent_id}, keeping all original shifts even if they overlap? Reply yes or no.`,
        );
        await this.queue(
          tx,
          request.manager_phone,
          `Request ${displayId} denied. No assignments changed; asking ${employee.name} whether they still want the urgent shift.`,
        );
      } else if (!yes) {
        status = 'declined';
        await this.queue(
          tx,
          employee.phone,
          'Thank you for your time. Your original assignments remain unchanged.',
        );
        await this.queue(
          tx,
          request.manager_phone,
          `${employee.name} declined the urgent shift after denial of request ${displayId}. No assignments changed.`,
        );
      } else {
        // Revalidate the exact schedule seen by the manager. Never release shifts
        // first: a filled urgent shift must leave every original assignment intact.
        const assigned = await this.assigned(request.employee_id, tx);
        const releaseValid = release.every((s) =>
          assigned.some(
            (a) =>
              a.id === s.id &&
              a.start_at === s.start_at &&
              a.end_at === s.end_at &&
              Date.parse(a.start_at) > Date.now(),
          ),
        );
        const knownConflicts = new Set(release.map((s) => s.id));
        const newConflict =
          urgent &&
          assigned.some(
            (s) => this.overlaps(s, urgent) && !knownConflicts.has(s.id),
          );
        if (
          !urgent ||
          urgent.start_at !== requestedUrgent.start_at ||
          urgent.end_at !== requestedUrgent.end_at ||
          urgent.employee_id ||
          urgent.status !== 'available' ||
          Date.parse(urgent.start_at) <= Date.now() ||
          !releaseValid ||
          newConflict
        ) {
          status = 'unavailable';
          await this.queue(
            tx,
            employee.phone,
            'The schedule changed while your request was pending. No assignments were changed. Please ask for a new offer.',
          );
          await this.queue(
            tx,
            request.manager_phone,
            `Request ${displayId} could not be completed because the schedule changed. No assignments were changed.`,
          );
        } else {
          await tx.execute({
            sql: "UPDATE shifts SET employee_id=?,status='not available' WHERE id=?",
            args: [request.employee_id, urgent.id],
          });
          if (actor === 'manager')
            for (const s of release)
              await tx.execute({
                sql: "UPDATE shifts SET employee_id=NULL,status='available' WHERE id=? AND employee_id=?",
                args: [s.id, request.employee_id],
              });
          status =
            actor === 'manager' ? 'approved' : 'accepted_without_release';
          await tx.execute({
            sql: "UPDATE shift_conversations SET status='assigned' WHERE employee_id=?",
            args: [request.employee_id],
          });
          await this.queue(
            tx,
            employee.phone,
            actor === 'manager'
              ? `Your request was approved. You have been removed from ${release.map((s) => this.label(s)).join('; ')} and assigned to ${this.label(urgent)}. Thank you!`
              : `Confirmed: you are assigned to ${this.label(urgent)}. Your original shifts remain assigned to you. Your manager has been notified.`,
          );
          await this.queue(
            tx,
            request.manager_phone,
            `${employee.name}: request ${displayId} ${status}. Assigned to ${this.label(urgent)}. ${actor === 'manager' ? 'Requested original shifts released.' : 'Employee explicitly accepted after denial; original assignments retained, including the disclosed overlaps.'}`,
          );
        }
      }
      await tx.execute({
        sql: 'UPDATE shift_change_requests SET status=? WHERE id=?',
        args: [status, id],
      });
      await tx.execute({
        sql: 'INSERT INTO whatsapp_messages(id) VALUES(?)',
        args: [messageId],
      });
      if (status === 'declined' || status === 'unavailable')
        await tx.execute({
          sql: "UPDATE shift_conversations SET status='declined' WHERE employee_id=?",
          args: [request.employee_id],
        });
      await tx.commit();
      return true;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  private delivery?: Promise<void>;
  flush(send: (phone: string, message: string) => Promise<unknown>) {
    return (this.delivery ??= this.deliver(send).finally(() => {
      this.delivery = undefined;
    }));
  }
  private async deliver(
    send: (phone: string, message: string) => Promise<unknown>,
  ) {
    const rows = (
      await this.db.execute(
        'SELECT * FROM shift_notifications WHERE sent_at IS NULL ORDER BY rowid',
      )
    ).rows;
    for (const row of rows) {
      await send(String(row.phone), String(row.message));
      await this.db.execute({
        sql: 'UPDATE shift_notifications SET sent_at=? WHERE id=?',
        args: [new Date().toISOString(), row.id],
      });
    }
  }
}
