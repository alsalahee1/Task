// Passenger SMS notifications with a pluggable gateway.
//
// Every message is stored in the `notifications` table (the audit trail the
// admin sees on the task). Delivery is pluggable:
//   - default: logged only (status LOGGED) — works out of the box for demos
//   - set SMS_WEBHOOK_URL to POST {to, body} JSON to any SMS gateway bridge
//     (Twilio/Vonage/Infobip etc. all accept this shape via a tiny relay,
//     or a serverless function can translate it to the vendor API).
export function createNotifier(db) {
  const insert = db.prepare(
    `INSERT INTO notifications (task_id, phone, message, status, created_at)
     VALUES (?,?,?,?,?)`);

  function send(taskId, phone, message) {
    if (!phone) return;
    const webhook = process.env.SMS_WEBHOOK_URL;
    const id = insert.run(taskId, phone, message, webhook ? 'SENDING' : 'LOGGED',
      new Date().toISOString()).lastInsertRowid;
    if (!webhook) return;
    // fire-and-forget; delivery status recorded when the gateway responds
    fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, body: message }),
    }).then(res => {
      db.prepare('UPDATE notifications SET status = ? WHERE id = ?')
        .run(res.ok ? 'SENT' : `FAILED_${res.status}`, id);
    }).catch(() => {
      db.prepare(`UPDATE notifications SET status = 'FAILED' WHERE id = ?`).run(id);
    });
  }

  // Lifecycle-triggered passenger messages.
  const MESSAGES = {
    ASSIGNED: (t, agent) =>
      `AeroAssist: ${agent || 'An assistant'} has been assigned to help you` +
      (t.flight_number ? ` for flight ${t.flight_number}` : '') + '.',
    ACCEPTED: (t, agent) =>
      `AeroAssist: ${agent || 'Your assistant'} is on the way to meet you.`,
    ARRIVED_AT_PICKUP: (t, agent, loc) =>
      `AeroAssist: your assistant has arrived at ${loc || 'the pickup point'}.`,
    PASSENGER_DELIVERED: (t, agent, loc) =>
      `AeroAssist: you have arrived at ${loc || 'your destination'}. Have a good trip!`,
  };

  function onTaskEvent(task, eventType, agentName, locationName) {
    const fn = MESSAGES[eventType];
    if (fn && task.passenger_phone)
      send(task.id, task.passenger_phone, fn(task, agentName, locationName));
  }

  return { send, onTaskEvent };
}
