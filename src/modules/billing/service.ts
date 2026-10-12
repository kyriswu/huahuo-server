import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/config.js';
import { DomainError, transaction, type Scope } from '../identity/store.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const asBig = (v: unknown) => BigInt(String(v ?? 0));
const asJson = (v: bigint) => { if (v > MAX_SAFE) throw new DomainError(409, 'BILLING_AMOUNT_TOO_LARGE'); return Number(v); };
const iso = (v: Date | string | null | undefined) => v ? new Date(v).toISOString() : null;
const dateIso = (v: Date | string) => v instanceof Date ? v.toISOString() : new Date(`${v}T00:00:00.000Z`).toISOString();
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

export interface GrantInput { userId: string; levelCode?: 'free'|'pilot_paid'|'pro'|'max'; status?: 'pending'|'active'|'grace_period'|'cancelled'|'expired'|'refunded'|'revoked'; source: string; grantKey: string; expiresAt?: Date | null; monthlyCredits?: bigint; }
export interface ReserveInput { userId: string; reservationKey: string; requestedCredits: bigint; taskId?: string | null; runId?: string | null; ttlMs?: number; }
export interface StorageReservationInput { userId: string; resourceKey: string; requestedBytes: bigint; ttlMs?: number; }

export class BillingService {
 constructor(readonly pool: pg.Pool, readonly config: AppConfig) {}
 private checkMode() { if (this.config.billingMode === 'disabled') throw new DomainError(503, 'BILLING_NOT_CONFIGURED'); }
 private async policy(tx: pg.PoolClient) {
  const r = await tx.query('SELECT policy_version,mode,monthly_credit_limit,currency FROM billing_policies WHERE policy_version=$1', [this.config.billingPolicyVersion]);
  if (!r.rows[0] || (this.config.billingMode === 'live' && r.rows[0].mode !== 'live') || (this.config.billingMode === 'development' && r.rows[0].mode !== 'development')) throw new DomainError(503, 'BILLING_POLICY_UNAVAILABLE');
  return r.rows[0] as {policy_version:string; mode:string; monthly_credit_limit:string; currency:string};
 }
 async ensureAccountTx(tx: pg.PoolClient, userId: string) {
  const policy = await this.policy(tx);
  await tx.query("INSERT INTO account_memberships(membership_id,user_id,level_code,status,policy_version,source) VALUES($1,$2,'free','active',$3,'development_fixture') ON CONFLICT(user_id) DO NOTHING", [randomUUID(), userId, policy.policy_version]);
  await tx.query('SELECT user_id FROM account_memberships WHERE user_id=$1 FOR UPDATE', [userId]);
  const start = monthStart(), end = nextMonth(start), key = `${userId}:${policy.policy_version}:${dateOnly(start)}`;
  await tx.query(`INSERT INTO credit_lots(lot_id,user_id,lot_kind,policy_version,period_start,period_end,expires_at,granted_credits,available_credits,source,grant_key)
   VALUES($1,$2,'monthly',$3,$4,$5,$5::date,$6,$6,'development_fixture',$7) ON CONFLICT(grant_key) DO NOTHING`, [randomUUID(), userId, policy.policy_version, dateOnly(start), dateOnly(end), asBig(policy.monthly_credit_limit), key]);
  await tx.query(`INSERT INTO usage_periods(user_id,period_start,period_end,credit_limit) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,period_start) DO NOTHING`, [userId, dateOnly(start), dateOnly(end), asBig(policy.monthly_credit_limit)]);
  return policy;
 }
 async grantEntitlement(input: GrantInput) {
  this.checkMode();
  return transaction(this.pool, async tx => {
   const policy = await this.policy(tx); const level = input.levelCode ?? 'free'; const status = input.status ?? 'active';
   if ((level === 'pro' || level === 'max') && !input.expiresAt) throw new DomainError(400, 'MEMBERSHIP_EXPIRY_REQUIRED');
   if ((level === 'free' || level === 'pilot_paid') && input.expiresAt) throw new DomainError(400, 'MEMBERSHIP_EXPIRY_INVALID');
   const existing = await tx.query('SELECT * FROM account_memberships WHERE user_id=$1 FOR UPDATE', [input.userId]);
   if (existing.rows[0] && existing.rows[0].source === input.source && existing.rows[0].policy_version === policy.policy_version) return this.membershipRow(existing.rows[0]);
   await tx.query(`INSERT INTO account_memberships(membership_id,user_id,level_code,status,policy_version,source,expires_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(user_id) DO UPDATE SET level_code=EXCLUDED.level_code,status=EXCLUDED.status,policy_version=EXCLUDED.policy_version,source=EXCLUDED.source,expires_at=EXCLUDED.expires_at,updated_at=now()`,
    [randomUUID(), input.userId, level, status, policy.policy_version, input.source, input.expiresAt ?? null]);
   if (input.monthlyCredits !== undefined) {
    const start = monthStart(), end = nextMonth(start);
    await tx.query(`INSERT INTO credit_lots(lot_id,user_id,lot_kind,policy_version,period_start,period_end,expires_at,granted_credits,available_credits,source,grant_key)
     VALUES($1,$2,'monthly',$3,$4,$5,$5::date,$6,$6,$7,$8) ON CONFLICT(grant_key) DO NOTHING`, [randomUUID(),input.userId,policy.policy_version,dateOnly(start),dateOnly(end),input.monthlyCredits,input.source,input.grantKey]);
   }
   const r = await tx.query('SELECT * FROM account_memberships WHERE user_id=$1', [input.userId]); return this.membershipRow(r.rows[0]);
  });
 }
 async grantPermanentCredits(userId: string, credits: bigint, source: string, grantKey: string) {
  if (credits <= 0n) throw new DomainError(400, 'BILLING_AMOUNT_INVALID'); this.checkMode();
  return transaction(this.pool, async tx => { const p = await this.ensureAccountTx(tx,userId);
   const r = await tx.query(`INSERT INTO credit_lots(lot_id,user_id,lot_kind,policy_version,granted_credits,available_credits,source,grant_key)
    VALUES($1,$2,'permanent',$3,$4,$4,$5,$6) ON CONFLICT(grant_key) DO NOTHING RETURNING lot_id`, [randomUUID(),userId,p.policy_version,credits,source,grantKey]);
   if (r.rowCount) await tx.query('INSERT INTO credit_ledger_entries(entry_id,user_id,lot_id,entry_type,credits) VALUES($1,$2,$3,\'grant\',$4)', [randomUUID(),userId,r.rows[0].lot_id,credits]);
   return { granted: r.rowCount === 1, credits: asJson(credits) };
  });
 }
 private membershipRow(row: Record<string, unknown>) { return { membershipId: String(row.membership_id), levelCode: String(row.level_code), status: String(row.status), expiresAt: iso(row.expires_at as Date | string | null) }; }
 async membership(scope: Scope) { return this.creditSummary(scope); }
 async creditSummary(scope: Scope) { this.checkMode(); return transaction(this.pool, async tx => {
  const p=await this.ensureAccountTx(tx,scope.userId), m=(await tx.query('SELECT * FROM account_memberships WHERE user_id=$1',[scope.userId])).rows[0];
  const start=dateOnly(monthStart()); const monthly=(await tx.query('SELECT * FROM credit_lots WHERE user_id=$1 AND lot_kind=\'monthly\' AND period_start=$2',[scope.userId,start])).rows[0];
  const permanent=(await tx.query("SELECT coalesce(sum(available_credits),0)::text available,coalesce(sum(reserved_credits),0)::text reserved FROM credit_lots WHERE user_id=$1 AND lot_kind='permanent' AND (expires_at IS NULL OR expires_at>now())",[scope.userId])).rows[0];
  const uncovered=(await tx.query('SELECT coalesce(sum(uncovered_credits),0)::text n FROM usage_periods WHERE user_id=$1',[scope.userId])).rows[0].n;
  const monthlyCredit={policyVersion:p.policy_version,quotaCredits:asJson(asBig(p.monthly_credit_limit)),periodStart:dateIso(monthly.period_start),periodEnd:dateIso(monthly.period_end),availableCredits:asJson(asBig(monthly.available_credits)),reservedCredits:asJson(asBig(monthly.reserved_credits)),settledCredits:asJson(asBig(monthly.settled_credits)),expiresAt:iso(monthly.expires_at)};
  const permanentLots=await tx.query("SELECT lot_id,source,granted_credits,available_credits,reserved_credits,created_at,expires_at FROM credit_lots WHERE user_id=$1 AND lot_kind='permanent' ORDER BY created_at DESC",[scope.userId]);
  return {membership:this.membershipRow(m),monthlyCredit,permanentCredit:{availableCredits:asJson(asBig(permanent.available)),reservedCredits:asJson(asBig(permanent.reserved)),lots:permanentLots.rows.map(l=>({lotId:l.lot_id,originKind:l.source==='development_fixture'?'admin_grant':l.source,originalCredits:asJson(asBig(l.granted_credits)),availableCredits:asJson(asBig(l.available_credits)),reservedCredits:asJson(asBig(l.reserved_credits)),createdAt:iso(l.created_at),expiresAt:null})),nextCursor:null},account:{runAdmission:asBig(uncovered)>0n?'blocked_uncovered_credit':'allowed',outstandingUncoveredCredits:asJson(asBig(uncovered))}};
 }); }
 async quotaSummary(scope: Scope) { this.checkMode(); return transaction(this.pool, async tx => {
  await this.ensureAccountTx(tx,scope.userId); const b=await tx.query(`SELECT coalesce(sum(granted_credits),0)::text granted,coalesce(sum(settled_credits),0)::text settled,coalesce(sum(reserved_credits),0)::text reserved FROM credit_lots WHERE user_id=$1`,[scope.userId]); const row=b.rows[0];
  const u=await tx.query("SELECT coalesce(sum(uncovered_credits),0)::text uncovered FROM usage_periods WHERE user_id=$1",[scope.userId]);
  return {items:[{quotaType:'credits',limitAmount:asJson(asBig(row.granted)),usedAmount:asJson(asBig(row.settled)),reservedAmount:asJson(asBig(row.reserved)),adjustedAmount:0,remainingAmount:asJson(asBig(row.granted)-asBig(row.settled)-asBig(row.reserved)),uncoveredAmount:asJson(asBig(u.rows[0].uncovered)),periodStart:new Date(monthStart()).toISOString(),periodEnd:new Date(nextMonth(monthStart())).toISOString()}]};
 }); }
 async reserveCredits(input: ReserveInput) { this.checkMode(); return transaction(this.pool,async tx=>this.reserveCreditsTx(tx,input)); }
 async reserveCreditsTx(tx: pg.PoolClient, input: ReserveInput) { if(input.requestedCredits<=0n)throw new DomainError(400,'BILLING_AMOUNT_INVALID');
  const p=await this.ensureAccountTx(tx,input.userId); const found=await tx.query('SELECT * FROM credit_reservations WHERE user_id=$1 AND reservation_key=$2 FOR UPDATE',[input.userId,input.reservationKey]);
  if(found.rows[0]) { const x=found.rows[0]; if(asBig(x.requested_credits)!==input.requestedCredits||x.task_id!==(input.taskId??null)||x.run_id!==(input.runId??null)) throw new DomainError(409,'RESERVATION_CONFLICT'); return this.reservationDto(x); }
  const uncovered=await tx.query('SELECT coalesce(sum(uncovered_credits),0)::text n FROM usage_periods WHERE user_id=$1',[input.userId]); if(asBig(uncovered.rows[0].n)>0n) throw new DomainError(409,'BILLING_UNCOVERED_CREDIT');
  const lots=await tx.query(`SELECT * FROM credit_lots WHERE user_id=$1 AND available_credits>0 AND (expires_at IS NULL OR expires_at>now()) ORDER BY CASE lot_kind WHEN 'monthly' THEN 0 ELSE 1 END,created_at FOR UPDATE`,[input.userId]);
  let left=input.requestedCredits; const allocations:{lot:Record<string, unknown>;credits:bigint}[]=[]; for(const lot of lots.rows as Record<string, unknown>[]){if(left<=0n)break;const n=asBig(lot.available_credits)<left?asBig(lot.available_credits):left;allocations.push({lot,credits:n});left-=n;}
  if(left>0n) throw new DomainError(409,'INSUFFICIENT_CREDITS');
  const rid=randomUUID(); const ttl=input.ttlMs??3600000; await tx.query(`INSERT INTO credit_reservations(reservation_id,user_id,task_id,run_id,reservation_key,policy_version,requested_credits,reserved_credits,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,'reserved',now()+$8*interval '1 millisecond')`,[rid,input.userId,input.taskId??null,input.runId??null,input.reservationKey,p.policy_version,input.requestedCredits,ttl]);
  for(const a of allocations){await tx.query('UPDATE credit_lots SET available_credits=available_credits-$1,reserved_credits=reserved_credits+$1 WHERE lot_id=$2',[a.credits,a.lot.lot_id]);await tx.query('INSERT INTO credit_reservation_lots(reservation_id,lot_id,credits) VALUES($1,$2,$3)',[rid,a.lot.lot_id,a.credits]);await tx.query("INSERT INTO credit_ledger_entries(entry_id,user_id,reservation_id,lot_id,entry_type,credits) VALUES($1,$2,$3,$4,'reserve',$5)",[randomUUID(),input.userId,rid,a.lot.lot_id,a.credits]);}
  return {reservationId:rid,status:'reserved',reservedCredits:asJson(input.requestedCredits)};
 }
 private reservationDto(r:Record<string, unknown>){return {reservationId:String(r.reservation_id),status:String(r.status),reservedCredits:asJson(asBig(r.reserved_credits))};}
 async commitReservation(id:string) { return transaction(this.pool,tx=>this.commitReservationTx(tx,id)); }
 async commitReservationTx(tx:pg.PoolClient,id:string) { const r=await tx.query('SELECT * FROM credit_reservations WHERE reservation_id=$1 FOR UPDATE',[id]);if(!r.rows[0])throw new DomainError(404,'RESERVATION_NOT_FOUND');const x=r.rows[0];if(x.status==='committed')return this.reservationDto(x);if(x.status!=='reserved')throw new DomainError(409,'RESERVATION_NOT_ACTIVE');const lots=await tx.query('SELECT * FROM credit_reservation_lots WHERE reservation_id=$1',[id]);for(const l of lots.rows){await tx.query('UPDATE credit_lots SET reserved_credits=reserved_credits-$1,settled_credits=settled_credits+$1 WHERE lot_id=$2',[l.credits,l.lot_id]);await tx.query("INSERT INTO credit_ledger_entries(entry_id,user_id,reservation_id,lot_id,entry_type,credits) VALUES($1,$2,$3,$4,'commit',$5)",[randomUUID(),x.user_id,id,l.lot_id,l.credits]);}await tx.query("UPDATE credit_reservations SET status='committed',updated_at=now() WHERE reservation_id=$1",[id]);await tx.query('UPDATE usage_periods SET settled_credits=settled_credits+$1 WHERE user_id=$2 AND period_start=date_trunc(\'month\',now())::date',[x.reserved_credits,x.user_id]);return {reservationId:id,status:'committed',reservedCredits:asJson(asBig(x.reserved_credits))}; }
 async releaseReservation(id:string) { return transaction(this.pool,tx=>this.releaseReservationTx(tx,id)); }
 async releaseExpiredReservations(limit = 100) {
  const ids = await this.pool.query<{reservation_id:string}>("SELECT reservation_id FROM credit_reservations WHERE status='reserved' AND expires_at<=now() ORDER BY expires_at LIMIT $1", [limit]);
  let released=0; for (const row of ids.rows) { try { const result=await this.releaseReservation(row.reservation_id); if(result.status==='released') released++; } catch (error) { if (!(error instanceof DomainError && error.code==='RESERVATION_NOT_ACTIVE')) throw error; } }
  return {released};
 }
 async reserveStorage(input: StorageReservationInput) { this.checkMode(); if(input.requestedBytes<=0n)throw new DomainError(400,'STORAGE_AMOUNT_INVALID'); return transaction(this.pool,async tx=>{
  await this.ensureAccountTx(tx,input.userId); const existing=await tx.query('SELECT * FROM storage_reservations WHERE user_id=$1 AND resource_key=$2 FOR UPDATE',[input.userId,input.resourceKey]);
  if(existing.rows[0]){const x=existing.rows[0];if(asBig(x.requested_bytes)!==input.requestedBytes)throw new DomainError(409,'STORAGE_RESERVATION_CONFLICT');return {reservationId:x.reservation_id,status:x.status,requestedBytes:asJson(asBig(x.requested_bytes)),confirmedBytes:asJson(asBig(x.confirmed_bytes))};}
  const id=randomUUID();await tx.query("INSERT INTO storage_reservations(reservation_id,user_id,resource_key,requested_bytes,status,expires_at) VALUES($1,$2,$3,$4,'reserved',now()+$5*interval '1 millisecond')",[id,input.userId,input.resourceKey,input.requestedBytes,input.ttlMs??3600000]);return {reservationId:id,status:'reserved',requestedBytes:asJson(input.requestedBytes),confirmedBytes:0};
 }); }
 async confirmStorage(id:string,bytes:bigint) { if(bytes<0n)throw new DomainError(400,'STORAGE_AMOUNT_INVALID'); return transaction(this.pool,async tx=>{const r=await tx.query('SELECT * FROM storage_reservations WHERE reservation_id=$1 FOR UPDATE',[id]);if(!r.rows[0])throw new DomainError(404,'STORAGE_RESERVATION_NOT_FOUND');const x=r.rows[0];if(x.status==='confirmed')return {reservationId:id,status:x.status,confirmedBytes:asJson(asBig(x.confirmed_bytes))};if(x.status!=='reserved')throw new DomainError(409,'STORAGE_RESERVATION_NOT_ACTIVE');if(bytes>asBig(x.requested_bytes))throw new DomainError(409,'STORAGE_RESERVATION_EXCEEDED');await tx.query("UPDATE storage_reservations SET status='confirmed',confirmed_bytes=$2,updated_at=now() WHERE reservation_id=$1",[id,bytes]);return {reservationId:id,status:'confirmed',confirmedBytes:asJson(bytes)};}); }
 async releaseStorage(id:string) { return transaction(this.pool,async tx=>{const r=await tx.query('SELECT * FROM storage_reservations WHERE reservation_id=$1 FOR UPDATE',[id]);if(!r.rows[0])throw new DomainError(404,'STORAGE_RESERVATION_NOT_FOUND');const x=r.rows[0];if(x.status==='released')return {reservationId:id,status:'released'};if(x.status!=='reserved')throw new DomainError(409,'STORAGE_RESERVATION_NOT_ACTIVE');await tx.query("UPDATE storage_reservations SET status='released',updated_at=now() WHERE reservation_id=$1",[id]);return {reservationId:id,status:'released'};}); }
 async releaseReservationTx(tx:pg.PoolClient,id:string) { const r=await tx.query('SELECT * FROM credit_reservations WHERE reservation_id=$1 FOR UPDATE',[id]);if(!r.rows[0])throw new DomainError(404,'RESERVATION_NOT_FOUND');const x=r.rows[0];if(x.status==='released')return this.reservationDto(x);if(x.status!=='reserved')throw new DomainError(409,'RESERVATION_NOT_ACTIVE');const lots=await tx.query('SELECT * FROM credit_reservation_lots WHERE reservation_id=$1',[id]);for(const l of lots.rows){await tx.query('UPDATE credit_lots SET reserved_credits=reserved_credits-$1,available_credits=available_credits+$1 WHERE lot_id=$2',[l.credits,l.lot_id]);await tx.query("INSERT INTO credit_ledger_entries(entry_id,user_id,reservation_id,lot_id,entry_type,credits) VALUES($1,$2,$3,$4,'release',$5)",[randomUUID(),x.user_id,id,l.lot_id,l.credits]);}await tx.query("UPDATE credit_reservations SET status='released',updated_at=now() WHERE reservation_id=$1",[id]);return {reservationId:id,status:'released',reservedCredits:asJson(asBig(x.reserved_credits))}; }
 async assertCanRun(userId:string,credits:bigint){ if(this.config.billingMode==='disabled')throw new DomainError(503,'BILLING_NOT_CONFIGURED'); if(credits<=0n)throw new DomainError(400,'BILLING_AMOUNT_INVALID'); return transaction(this.pool,async tx=>{await this.ensureAccountTx(tx,userId);const u=await tx.query('SELECT coalesce(sum(uncovered_credits),0)::text n FROM usage_periods WHERE user_id=$1',[userId]);if(asBig(u.rows[0].n)>0n)throw new DomainError(409,'BILLING_UNCOVERED_CREDIT');return true;}); }
 async markMeasurementPending(userId:string,input:{runId?:string;reservationId?:string;usageKind:string;provider?:string}) { this.checkMode(); return this.pool.query(`INSERT INTO provider_usage_measurements(measurement_id,user_id,run_id,reservation_id,usage_kind,provider,measurement_status) VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING measurement_id`,[randomUUID(),userId,input.runId??null,input.reservationId??null,input.usageKind,input.provider??null]).then(r=>({measurementId:r.rows[0].measurement_id,status:'pending'})); }
 async recordRunUsage(input:{runId:string;userId:string;taskId?:string;reservationId?:string;rawInputTokens?:bigint;rawOutputTokens?:bigint;accountedCredits:bigint;unknown?:boolean;assistantResultPersisted:boolean}) { this.checkMode(); return transaction(this.pool,async tx=>{const p=await this.ensureAccountTx(tx,input.userId);const status=input.unknown?'uncovered':'settled';const uncovered=input.unknown?input.accountedCredits:0n;await tx.query(`INSERT INTO run_usage(run_id,user_id,task_id,reservation_id,policy_version,raw_input_tokens,raw_output_tokens,accounted_credits,uncovered_credits,settlement_status,assistant_result_persisted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(run_id) DO UPDATE SET settlement_status=EXCLUDED.settlement_status,accounted_credits=EXCLUDED.accounted_credits,uncovered_credits=EXCLUDED.uncovered_credits,assistant_result_persisted=EXCLUDED.assistant_result_persisted,updated_at=now()`,[input.runId,input.userId,input.taskId??null,input.reservationId??null,p.policy_version,input.rawInputTokens??0n,input.rawOutputTokens??0n,input.accountedCredits,uncovered,status,input.assistantResultPersisted]);if(input.unknown)await tx.query("UPDATE usage_periods SET uncovered_credits=uncovered_credits+$1 WHERE user_id=$2 AND period_start=date_trunc('month',now())::date",[uncovered,input.userId]);return {runId:input.runId,policyVersion:p.policy_version,rawInputTokens:asJson(input.rawInputTokens??0n),rawOutputTokens:asJson(input.rawOutputTokens??0n),accountedCredits:asJson(input.accountedCredits),settlementStatus:status,assistantResultPersisted:input.assistantResultPersisted,measurements:[]};}); }
 async runUsage(scope:Scope,runId:string){this.checkMode();return transaction(this.pool,async tx=>{const r=await tx.query('SELECT * FROM run_usage WHERE run_id=$1 AND user_id=$2',[runId,scope.userId]);if(!r.rows[0])throw new DomainError(404,'RUN_USAGE_NOT_FOUND');const x=r.rows[0];const ms=await tx.query('SELECT * FROM provider_usage_measurements WHERE run_id=$1 ORDER BY created_at',[runId]);return {runId:x.run_id,policyVersion:x.policy_version,rawInputTokens:asJson(asBig(x.raw_input_tokens)),rawOutputTokens:asJson(asBig(x.raw_output_tokens)),accountedCredits:asJson(asBig(x.accounted_credits)),settlementStatus:x.settlement_status,assistantResultPersisted:x.assistant_result_persisted,measurements:ms.rows.map(m=>({usageKind:m.usage_kind,measurementStatus:m.measurement_status,accountedCredits:asJson(asBig(m.accounted_credits)),rawInputTokens:asJson(asBig(m.raw_input_tokens)),rawOutputTokens:asJson(asBig(m.raw_output_tokens)),mediaQuantity:asJson(asBig(m.media_quantity)),successfulAnalyzedImageCount:0,mediaDurationSeconds:asJson(asBig(m.media_duration_seconds)),providerCost:{amount:((asBig(m.provider_cost_minor??0n))/100n).toString()+'.'+String(asBig(m.provider_cost_minor??0n)%100n).padStart(2,'0'),currency:m.provider_currency??'USD'}}))};}); }
}
