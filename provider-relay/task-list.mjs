import { taskView } from './task-contract.mjs';

const bad = () => { throw Object.assign(new Error('invalid_pagination'), { status: 400, code: 'invalid_pagination' }); };
export function listTasks(store, owner, search = '', model) {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some(k => !['limit', 'cursor'].includes(k)) || ['limit', 'cursor'].some(k => params.getAll(k).length > 1)) bad();
  const rawLimit = params.get('limit') ?? '20';
  if (!/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > 50) bad();
  let cursor;
  if (params.has('cursor')) {
    try {
      const raw = params.get('cursor');
      if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) bad();
      cursor = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!Number.isSafeInteger(cursor.time) || typeof cursor.id !== 'string' || cursor.id.length > 100) bad();
    } catch { bad(); }
  }
  // The cursor is only an ordering boundary, never an authorization token.
  const rows = [...store.jobs.values()].filter(j => j.owner === owner && (!model || j.model === model))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id === b.id ? 0 : -1))
    .filter(j => !cursor || j.createdAt < cursor.time || (j.createdAt === cursor.time && j.id < cursor.id));
  const page = rows.slice(0, Number(rawLimit));
  const last = page.at(-1);
  return {
    items: page.map(j => ({
      job_id: j.id, model: j.model ?? null, status: j.status, ...taskView(j, store.now()),
      result_job_id: j.status === 'succeeded' && j.result ? j.id : null,
      // Never copy legacy upstream error bodies, prompts, signed URLs or credentials.
      error: j.error ? { code: /^[a-z0-9_]{1,64}$/.test(j.error.code) ? j.error.code : 'task_error', message: '任务未完成，请查看任务状态与操作能力' } : null,
      expires_at: ['succeeded', 'failed', 'canceled'].includes(j.status) && j.finishedAt != null ? j.finishedAt + store.retentionMs : null,
    })),
    next_cursor: rows.length > page.length && last ? Buffer.from(JSON.stringify({ time: last.createdAt, id: last.id })).toString('base64url') : null,
    retention_ms: store.retentionMs,
  };
}
