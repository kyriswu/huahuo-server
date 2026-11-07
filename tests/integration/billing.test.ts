import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config/config.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { insertFixtureUser, insertFixtureSession } from './jwt-fixture.js';
import { BillingService } from '../../src/modules/billing/service.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('TEST_DB_REQUIRED');
const env={...process.env,APP_ENV:'test',BILLING_MODE:'development',BILLING_POLICY_VERSION:'credit-policy-v1',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'test-'.repeat(12),APP_PUBLIC_BASE_URL:'http://localhost:3000'};
const cfg=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL});
const root=poolFor(loadConfig('migrate',{...env,DATABASE_URL:migrationUrl}));
const pool=poolFor(cfg);const billing=new BillingService(pool,cfg);
async function fixture(){return insertFixtureUser(root);}
describe('P04 billing ledger',()=>{
 beforeAll(async()=>{await migrate(loadConfig('migrate',{...env,DATABASE_URL:migrationUrl}));});
 afterAll(async()=>{await Promise.all([root.end(),pool.end()]);});
 it('creates App-compatible development account and separates monthly/permanent credits',async()=>{const user=await fixture();const scope={userId:user,sessionId:randomUUID(),traceId:randomUUID()};await insertFixtureSession(root,user,scope.sessionId);const x=await billing.membership(scope);expect(x.membership.levelCode).toBe('free');expect(x.monthlyCredit.quotaCredits).toBe(10000000);expect(x.permanentCredit.availableCredits).toBe(0);expect(x.account.runAdmission).toBe('allowed');});
 it('serializes concurrent reservations and replays idempotently',async()=>{const user=await fixture();const key=`test:${randomUUID()}`;const [a,b]=await Promise.all([billing.reserveCredits({userId:user,reservationKey:key,requestedCredits:7000000n}),billing.reserveCredits({userId:user,reservationKey:key,requestedCredits:7000000n})]);expect(a.reservationId).toBe(b.reservationId);const other=await billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:3000000n});expect(other.status).toBe('reserved');await expect(billing.reserveCredits({userId:user,reservationKey:key,requestedCredits:1n})).rejects.toMatchObject({code:'RESERVATION_CONFLICT'});await expect(billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:1n})).rejects.toMatchObject({code:'INSUFFICIENT_CREDITS'});});
 it('commit and release are one-time transitions',async()=>{const user=await fixture();const r=await billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:2n});expect((await billing.commitReservation(r.reservationId)).status).toBe('committed');expect((await billing.commitReservation(r.reservationId)).status).toBe('committed');const s=await billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:2n});expect((await billing.releaseReservation(s.reservationId)).status).toBe('released');expect((await billing.releaseReservation(s.reservationId)).status).toBe('released');});
 it('unknown provider measurement is uncovered and blocks admission',async()=>{const user=await fixture();const runId=randomUUID();await billing.recordRunUsage({runId,userId:user,accountedCredits:4n,unknown:true,assistantResultPersisted:true});const scope={userId:user,sessionId:randomUUID(),traceId:randomUUID()};await insertFixtureSession(root,user,scope.sessionId);const x=await billing.creditSummary(scope);expect(x.account.runAdmission).toBe('blocked_uncovered_credit');expect((await billing.runUsage(scope,runId)).settlementStatus).toBe('uncovered');await expect(billing.assertCanRun(user,1n)).rejects.toMatchObject({code:'BILLING_UNCOVERED_CREDIT'});});
 it('permanent grant is idempotent',async()=>{const user=await fixture();expect((await billing.grantPermanentCredits(user,5n,'admin_grant','fixture-grant')).granted).toBe(true);expect((await billing.grantPermanentCredits(user,5n,'admin_grant','fixture-grant')).granted).toBe(false);});
 it('rejects missing users before creating billing relations',async()=>{
  const userId=randomUUID();
  await expect(billing.grantEntitlement({userId,source:'fixture',grantKey:randomUUID()})).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  await expect(billing.grantPermanentCredits(userId,1n,'fixture',randomUUID())).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  await expect(billing.reserveStorage({userId,resourceKey:randomUUID(),requestedBytes:1n})).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  await expect(billing.recordRunUsage({runId:randomUUID(),userId,accountedCredits:1n,assistantResultPersisted:true})).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  await expect(billing.markMeasurementPending(userId,{usageKind:'embedding'})).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  expect((await root.query('SELECT count(*)::int n FROM account_memberships WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
  expect((await root.query('SELECT count(*)::int n FROM provider_usage_measurements WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
 });
 it('requires owned task and reservation references at billing write boundaries',async()=>{
  const userId=await fixture(),otherUserId=await fixture(),workspaceId=randomUUID(),taskId=randomUUID();
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'billing-reference-fixture',true,$3)",[workspaceId,userId,randomUUID()]);
  await root.query("INSERT INTO tasks(id,user_id,workspace_id,kind,queue,state) VALUES($1,$2,$3,'demo.digest','content','queued')",[taskId,userId,workspaceId]);
  await expect(billing.reserveCredits({userId:otherUserId,taskId,reservationKey:randomUUID(),requestedCredits:1n})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await expect(billing.reserveCredits({userId,taskId:randomUUID(),reservationKey:randomUUID(),requestedCredits:1n})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  const runId=randomUUID(),reservation=await billing.reserveCredits({userId,taskId,runId,reservationKey:randomUUID(),requestedCredits:1n});
  await expect(billing.markMeasurementPending(otherUserId,{reservationId:reservation.reservationId,usageKind:'embedding'})).rejects.toMatchObject({code:'RESERVATION_NOT_FOUND'});
  await expect(billing.markMeasurementPending(userId,{reservationId:randomUUID(),usageKind:'embedding'})).rejects.toMatchObject({code:'RESERVATION_NOT_FOUND'});
  await expect(billing.recordRunUsage({userId:otherUserId,runId:randomUUID(),taskId,accountedCredits:1n,assistantResultPersisted:true})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await expect(billing.recordRunUsage({userId,runId:randomUUID(),reservationId:reservation.reservationId,accountedCredits:1n,assistantResultPersisted:true})).rejects.toMatchObject({code:'RESERVATION_CONFLICT'});
  await billing.recordRunUsage({userId,taskId,runId,reservationId:reservation.reservationId,accountedCredits:1n,assistantResultPersisted:true});
  const measurement=await billing.markMeasurementPending(userId,{runId,reservationId:reservation.reservationId,usageKind:'embedding'});
  expect(measurement.status).toBe('pending');
 });
 it('does not reassign a recorded run or expose another account measurement',async()=>{
  const userId=await fixture(),otherUserId=await fixture(),runId=randomUUID();
  await billing.recordRunUsage({userId,runId,accountedCredits:2n,assistantResultPersisted:true});
  await expect(billing.recordRunUsage({userId:otherUserId,runId,accountedCredits:99n,assistantResultPersisted:true})).rejects.toMatchObject({code:'RUN_USAGE_CONFLICT'});
  await expect(billing.markMeasurementPending(otherUserId,{runId,usageKind:'foreign'})).rejects.toMatchObject({code:'RUN_USAGE_CONFLICT'});
  await billing.markMeasurementPending(userId,{runId,usageKind:'owned'});
  // Simulate imported inconsistent data. The read boundary must still scope it.
  await root.query("INSERT INTO provider_usage_measurements(measurement_id,user_id,run_id,usage_kind,measurement_status) VALUES($1,$2,$3,'foreign','pending')",[randomUUID(),otherUserId,runId]);
  const usage=await billing.runUsage({userId,sessionId:randomUUID(),traceId:randomUUID()},runId);
  expect(usage.accountedCredits).toBe(2);expect(usage.measurements.map(x=>x.usageKind)).toEqual(['owned']);
  expect((await root.query('SELECT user_id FROM run_usage WHERE run_id=$1',[runId])).rows[0].user_id).toBe(userId);
 });
 it('storage reservation confirms or releases without charging unknown bytes',async()=>{const user=await fixture();const r=await billing.reserveStorage({userId:user,resourceKey:`file:${randomUUID()}`,requestedBytes:100n});expect(r.status).toBe('reserved');expect((await billing.confirmStorage(r.reservationId,60n)).confirmedBytes).toBe(60);const s=await billing.reserveStorage({userId:user,resourceKey:`file:${randomUUID()}`,requestedBytes:20n});expect((await billing.releaseStorage(s.reservationId)).status).toBe('released');});
});
