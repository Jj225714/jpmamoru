export const terminal = new Set(['succeeded', 'failed', 'canceled', 'uncertain']);

// No upstream supplies a trustworthy percentage or ETA.
export function taskView(job, now = Date.now()) {
  const recover = job.status === 'recoverable' && !!job.providerJobId;
  const localCancel = job.durableQueue && job.queueState === 'waiting' && job.status === 'queued';
  const cancel = localCancel || (!terminal.has(job.status) && !!job.providerJobId && !job.cancelRequested);
  return {
    created_at: job.createdAt ?? null,
    updated_at: job.updatedAt ?? job.createdAt ?? null,
    started_at: job.startedAt ?? null,
    finished_at: job.finishedAt ?? null,
    elapsed_ms: job.createdAt == null ? null : Math.max(0, (job.finishedAt ?? now) - job.createdAt),
    queue_mode: job.durableQueue ? 'encrypted_persistent' : 'admission_only',
    result_expired: !!job.resultExpired,
    progress: { stage: job.stage || job.status, percent: job.status === 'succeeded' ? 100 : null },
    actions: {
      cancel: { allowed: cancel, reason: localCancel ? 'local_waiting' : cancel ? 'provider_cancel_request' : job.cancelRequested ? 'cancel_pending' : 'not_cancelable' },
      retry: { allowed: recover, mode: recover ? 'resume_query' : null, reason: recover ? 'existing_provider_job' : job.status === 'uncertain' ? 'acceptance_uncertain' : 'paid_resubmit_disabled' },
    },
  };
}

export class TaskLimits {
  constructor(maxActive = 2, modelLimits = {}) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 32 || !modelLimits || typeof modelLimits !== 'object' || Array.isArray(modelLimits)) throw new Error('Invalid task limits');
    for (const limit of Object.values(modelLimits)) if (!Number.isInteger(limit) || limit < 1 || limit > maxActive) throw new Error('Invalid model limit');
    this.max = maxActive; this.models = { ...modelLimits }; this.active = new Map();
  }
  acquire(id, model) {
    if (this.active.has(id)) return false;
    if (this.active.size >= this.max || [...this.active.values()].filter(v => v === model).length >= (this.models[model] ?? this.max)) throw Object.assign(new Error('job_capacity'), { status: 429, code: 'job_capacity' });
    this.active.set(id, model); return true;
  }
  release(id) { this.active.delete(id); }
}
