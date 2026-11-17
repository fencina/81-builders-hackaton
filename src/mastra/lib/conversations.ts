import { z } from 'zod';
import { agent } from '../agents/agent';
import { assignShift, db, findUrgentShifts, getConversation, getEmployees, initializeDatabase, setConversation } from './database';
import { ShiftRequests } from './shift-requests';
import { businessTimezone } from './database';
import { normalizePhone, resolveSenderPhone, sendWhatsAppMessage, sendWhatsAppToPhone } from './whatsapp';
export const shiftRequests = new ShiftRequests(db, businessTimezone);
export async function flushShiftNotifications() {
  await initializeDatabase();
  await shiftRequests.flush(sendWhatsAppToPhone);
}

export const incomingMessage = z.object({
  event: z.literal('message.received'),
  sessionId: z.string().optional(),
  data: z.object({
    id: z.string(), from: z.string(), senderPhone: z.string().nullish(), body: z.string(),
    fromMe: z.boolean().optional(), isGroup: z.boolean().optional(),
  }),
});
const decisionSchema = z.object({
  decision: z.enum(['continue', 'accepted', 'declined']),
  shift_id: z.string().nullable(),
  release_shift_ids: z.array(z.string()),
  message: z.string().min(1),
});
const pending = new Map<string, Promise<unknown>>();
const queues = new Map<string, Promise<unknown>>();

export function handleIncomingMessage(payload: z.infer<typeof incomingMessage>) {
  const key = `${payload.sessionId || 'default'}:${payload.data.id}`;
  if (pending.has(key)) return pending.get(key)!;
  const phone = (payload.data.senderPhone || payload.data.from.split('@')[0]).replace(/\D/g, '');
  const previous = queues.get(phone) || Promise.resolve();
  console.log('[whatsapp] received', { messageId: key, from: payload.data.from });
  const task = previous.catch(() => {}).then(() => respond(payload, key)).then(result => {
    console.log('[whatsapp] result', { messageId: key, ...result });
    return result;
  }).catch(error => {
    console.error('[whatsapp] failed', { messageId: key, error: String(error) });
    throw error;
  });
  pending.set(key, task);
  queues.set(phone, task);
  void task.finally(() => {
    pending.delete(key);
    if (queues.get(phone) === task) queues.delete(phone);
  }).catch(() => {});
  return task;
}

async function respond(payload: z.infer<typeof incomingMessage>, messageId: string) {
  const message = payload.data;
  if (payload.sessionId && payload.sessionId !== process.env.OPENWA_SESSION_ID) return { ignored: true };
  if (message.fromMe || message.isGroup || message.from.endsWith('@g.us') || !message.body.trim()) return { ignored: true };
  const phone = await resolveSenderPhone(message.from, message.senderPhone);
  if (!phone) return { ignored: true, reason: 'Could not resolve sender phone' };
  await initializeDatabase();
  await flushShiftNotifications();
  const managerCommand = message.body.trim().match(/^(APPROVE|DENY)\s+([a-f0-9-]{36})$/i);
  if (managerCommand) {
    const changed = await shiftRequests.decide(managerCommand[2], 'manager', phone, managerCommand[1].toUpperCase() === 'APPROVE', messageId);
    await flushShiftNotifications();
    return { received: true, changed };
  }
  if (process.env.SHIFT_MANAGER_PHONE && normalizePhone(process.env.SHIFT_MANAGER_PHONE) === phone) {
    await sendWhatsAppToPhone(phone, 'To decide a shift change request, reply APPROVE <request ID> or DENY <request ID> using the ID in the request.');
    return { received: true };
  }
  const employee = (await getEmployees()).find(e => normalizePhone(e.phone_number) === phone);
  if (!employee) return { ignored: true, reason: 'Unknown employee' };
  if ((await db.execute({ sql: 'SELECT id FROM whatsapp_messages WHERE id = ?', args: [messageId] })).rows.length) return { ignored: true, reason: 'Duplicate message' };
  const request = await shiftRequests.pending(employee.id);
  if (request) {
    if (request.status === 'manager_pending') {
      await sendWhatsAppMessage(employee.id, `Your shift change request ${request.id} is awaiting your manager's decision. No assignments have changed.`);
    } else {
      const answer = message.body.trim().toLowerCase().replace(/[.!¡¿?]+$/g, '');
      const yes = /^(yes|y|sí|si|s|yes please|si por favor|sí por favor)$/.test(answer);
      const no = /^(no|n|no thanks|no gracias)$/.test(answer);
      if (yes || no) {
        await shiftRequests.decide(request.id, 'employee', phone, yes, messageId);
        await flushShiftNotifications();
      } else await sendWhatsAppMessage(employee.id, 'Your release request was denied. Reply yes to take the urgent shift and keep your original shifts (even if they overlap), or no to decline.');
    }
    return { received: true, status: request.status };
  }
  const urgent = await findUrgentShifts();
  const conversation = await getConversation(employee.id);
  if (conversation?.offer_date === urgent.date && conversation.status !== 'active') return { ignored: true, reason: 'Conversation closed' };
  const sent = await db.execute({ sql: 'SELECT shift_id FROM outreach WHERE employee_id = ?', args: [employee.id] });
  const shifts = urgent.shifts.filter(s => sent.rows.some(r => r.shift_id === s.id));
  if (!shifts.length) return { ignored: true, reason: 'No pending shift offers' };
  console.log('[whatsapp] generating reply', { messageId, employeeId: employee.id, offeredShifts: shifts.length });
  const assignedShifts = (await shiftRequests.assigned(employee.id)).filter(s => Date.parse(s.start_at) > Date.now());
  const response = await agent.generate(`REPLY MODE.\n${JSON.stringify({ employee, timezone: urgent.timezone, offered_shifts: shifts, assigned_shifts: assignedShifts, employee_message: message.body })}`, {
    memory: { thread: `employee-${employee.id}`, resource: employee.id },
    activeTools: [],
    structuredOutput: { schema: decisionSchema },
  });
  const decision = response.object;
  if (!decision) throw new Error('Agent did not return a conversation decision');
  console.log('[whatsapp] decision', { messageId, employeeId: employee.id, decision: decision.decision, shiftId: decision.shift_id });
  let status: 'active' | 'assigned' | 'declined' = 'active';
  let reply = decision.message;
  if (decision.decision === 'declined') status = 'declined';
  if (decision.decision === 'accepted') {
    const shift = shifts.find(s => s.id === decision.shift_id);
    if (!shift) {
      reply = 'Which of the offered shifts can you work? Please tell me the shift or its start time.';
    } else if (decision.release_shift_ids.length || assignedShifts.some(s => shiftRequests.overlaps(s, shift))) {
      const releaseIds = decision.release_shift_ids;
      if (releaseIds.some(id => !assignedShifts.some(s => s.id === id))) {
        await sendWhatsAppMessage(employee.id, 'Which of your assigned future shifts do you want to be removed from? Please specify the date and time.');
        return { received: true, status: 'active' };
      }
      if (!process.env.SHIFT_MANAGER_PHONE) {
        await sendWhatsAppMessage(employee.id, 'This shift change needs manager approval, but manager messaging is not configured yet. No assignments have changed. Please contact your manager.');
        return { received: true, status: 'active' };
      }
      await shiftRequests.create(employee.id, shift.id, releaseIds, process.env.SHIFT_MANAGER_PHONE);
      await db.execute({ sql: 'INSERT OR IGNORE INTO whatsapp_messages (id) VALUES (?)', args: [messageId] });
      await flushShiftNotifications();
      return { received: true, status: 'manager_pending' };
    } else if ((await assignShift(shift.id, employee.id)).assigned) {
      status = 'assigned';
      const format = (date: string) => new Intl.DateTimeFormat('en-GB', { timeZone: urgent.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
      reply = `Confirmed! You are assigned to ${shift.id}: ${format(shift.start_at)} – ${format(shift.end_at)} (${urgent.timezone}). Thank you!`;
    } else {
      reply = 'That shift has just been filled. Would you like one of the other offered shifts?';
    }
  }
  // Save the decision before delivery so a closed conversation cannot assign another shift.
  await setConversation(employee.id, urgent.date, status);
  await sendWhatsAppMessage(employee.id, reply);
  await db.execute({ sql: 'INSERT OR IGNORE INTO whatsapp_messages (id) VALUES (?)', args: [messageId] });
  return { received: true, status };
}
