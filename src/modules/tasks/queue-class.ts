export const TASK_QUEUE_CLASSES = [
  "transactional",
  "notification",
  "maintenance",
  "default",
] as const;

export type TaskQueueClass = (typeof TASK_QUEUE_CLASSES)[number];

const QUEUE_DEFAULTS: Record<string, { queueClass: TaskQueueClass; priority: number }> = {
  "auth.login_code_email": { queueClass: "transactional", priority: 0 },
  "auth.magic_link_email": { queueClass: "transactional", priority: 0 },
  email: { queueClass: "transactional", priority: 10 },
  "subscription.renewal_reminder": { queueClass: "transactional", priority: 10 },
  publish_post: { queueClass: "default", priority: 20 },
  "payment_provider_event.dispatch": { queueClass: "default", priority: 20 },
  "subscription.reconcile": { queueClass: "default", priority: 30 },
  "notification.campaign_expand": { queueClass: "notification", priority: 80 },
  "notification.deliver": { queueClass: "notification", priority: 90 },
  "notification.campaign_finalize": { queueClass: "notification", priority: 95 },
  "file.cleanup_orphan": { queueClass: "maintenance", priority: 120 },
  "storage.delete_object": { queueClass: "maintenance", priority: 120 },
  "payment_proof.cleanup": { queueClass: "maintenance", priority: 120 },
};

export function queueDefaultsForTaskKind(kind: string): {
  queueClass: TaskQueueClass;
  priority: number;
} {
  return QUEUE_DEFAULTS[kind] ?? { queueClass: "default", priority: 100 };
}

export function isTaskQueueClass(value: string): value is TaskQueueClass {
  return (TASK_QUEUE_CLASSES as readonly string[]).includes(value);
}
