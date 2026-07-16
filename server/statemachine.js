// Task lifecycle. Stage events double as the task's status.
// Storage stages are skipped when the task has no storage_id
// (chair already at gate / passenger uses own chair).

export const STAGES_WITH_STORAGE = [
  'ASSIGNED', 'ACCEPTED', 'EN_ROUTE_TO_STORAGE', 'WHEELCHAIR_COLLECTED',
  'ARRIVED_AT_PICKUP', 'PASSENGER_PICKED_UP', 'IN_TRANSIT',
  'PASSENGER_DELIVERED', 'COMPLETED',
];
export const STAGES_NO_STORAGE = STAGES_WITH_STORAGE.filter(
  s => s !== 'EN_ROUTE_TO_STORAGE' && s !== 'WHEELCHAIR_COLLECTED');

export const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED'];
export const LOG_ONLY_EVENTS = ['PROBLEM_REPORTED', 'ESCALATED'];

export function stagesFor(task) {
  return task.storage_id ? STAGES_WITH_STORAGE : STAGES_NO_STORAGE;
}

// The single next stage-event a task can take, or null if terminal/unassigned.
export function nextStage(task) {
  if (TERMINAL_STATUSES.includes(task.status)) return null;
  const stages = stagesFor(task);
  if (task.status === 'CREATED') return null; // must be assigned first (via /assign)
  const i = stages.indexOf(task.status);
  if (i === -1 || i === stages.length - 1) return null;
  return stages[i + 1];
}

export function validateEvent(task, type) {
  if (LOG_ONLY_EVENTS.includes(type)) {
    if (TERMINAL_STATUSES.includes(task.status))
      return { ok: false, error: `Cannot report on a ${task.status} task` };
    return { ok: true, statusChange: null };
  }
  const expected = nextStage(task);
  if (!expected)
    return { ok: false, error: `Task is ${task.status}; no stage event allowed` };
  if (type !== expected)
    return { ok: false, error: `Out of order: expected ${expected}, got ${type}`, expected };
  return { ok: true, statusChange: type };
}

// Human labels for the agent app's single action button.
export const STAGE_ACTION_LABELS = {
  ACCEPTED: 'Accept task',
  EN_ROUTE_TO_STORAGE: 'Heading to wheelchair storage',
  WHEELCHAIR_COLLECTED: 'Wheelchair collected',
  ARRIVED_AT_PICKUP: 'Arrived at pickup point',
  PASSENGER_PICKED_UP: 'Passenger picked up',
  IN_TRANSIT: 'Start moving to destination',
  PASSENGER_DELIVERED: 'Passenger delivered',
  COMPLETED: 'Complete task',
};
