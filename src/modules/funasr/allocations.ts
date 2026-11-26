import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { FunAsrCompute } from '../../integrations/funasr-compute/index.js';
import { lock, transaction } from '../identity/store.js';

export class FunAsrAllocations {
  constructor(private readonly pool: pg.Pool, private readonly compute: FunAsrCompute,
    private readonly provider: 'fixed' | 'acs', private readonly idleMs: number) {}

  async assign(tx: pg.PoolClient, taskId: string): Promise<string> {
    await lock(tx, `funasr-allocations:${this.provider}`);
    const active = await tx.query<{ id: string }>("SELECT id FROM funasr_allocations WHERE provider=$1 AND state='active'", [this.provider]);
    const id = active.rows[0]?.id ?? randomUUID();
    if (!active.rowCount) await tx.query('INSERT INTO funasr_allocations(id,provider) VALUES($1,$2)', [id, this.provider]);
    await tx.query('UPDATE funasr_jobs SET allocation_id=$2 WHERE task_id=$1', [taskId, id]);
    return id;
  }

  async retire(id: string) {
    await this.pool.query("UPDATE funasr_allocations SET state='releasing' WHERE id=$1 AND provider=$2 AND state='active'", [id, this.provider]);
  }

  async collect(signal?: AbortSignal) {
    const id = await transaction(this.pool, async tx => {
      await lock(tx, `funasr-allocations:${this.provider}`);
      const releasable = await tx.query<{ id: string }>(`SELECT a.id FROM funasr_allocations a
        WHERE a.provider=$1 AND a.state IN ('active','releasing') AND NOT EXISTS (
          SELECT 1 FROM funasr_jobs j WHERE j.allocation_id=a.id
            AND (j.finished_at IS NULL OR j.finished_at > now()-$2*interval '1 millisecond')
        ) ORDER BY a.created_at LIMIT 1`, [this.provider, this.idleMs]);
      const row = releasable.rows[0];
      if (!row) return;
      await tx.query("UPDATE funasr_allocations SET state='releasing' WHERE id=$1", [row.id]);
      return row.id;
    });
    if (id && await this.compute.release(id, signal) === 'released') {
      await this.pool.query("UPDATE funasr_allocations SET state='released' WHERE id=$1 AND state='releasing'", [id]);
    }
  }
}
