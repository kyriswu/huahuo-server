import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadTestConfig as loadConfig } from '../sms-fixture.js';
import { poolFor } from '../../src/plugins/dependencies.js';
import { migrate } from '../../src/db/migrate.js';
import { insertFixtureUser, insertFixtureSession } from './jwt-fixture.js';
import { BillingService } from '../../src/modules/billing/service.js';
const migrationUrl=process.env.TEST_DATABASE_MIGRATION_URL;
if(!migrationUrl||!/^huahuo_test_/.test(new URL(migrationUrl).pathname.slice(1)))throw new Error('TEST_DB_REQUIRED');
const env={...process.env,APP_ENV:'test',BILLING_MODE:'development',LOG_LEVEL:'silent',APP_TOKEN_SECRET:'test-'.repeat(12),APP_PUBLIC_BASE_URL:'http://localhost:3000'};
const cfg=loadConfig('api-server',{...env,DATABASE_URL:process.env.TEST_DATABASE_API_URL});
const root=poolFor(loadConfig('migrate',{...env,DATABASE_URL:migrationUrl}));
const pool=poolFor(cfg);const billing=new BillingService(pool,cfg);
async function fixture(){return insertFixtureUser(root);}
async function runFact(userId:string,runId:string,uncovered=false){
 await billing.reserveCredits({userId,reservationKey:randomUUID(),requestedCredits:1n});
 await root.query("INSERT INTO run_usage(run_id,user_id,policy_version,accounted_credits,uncovered_credits,settlement_status,assistant_result_persisted) VALUES($1,$2,$3,2,$4,$5,true)",[runId,userId,cfg.billingPolicyVersion,uncovered?4:0,uncovered?'uncovered':'settled']);
 if(uncovered)await root.query("UPDATE usage_periods SET uncovered_credits=4 WHERE user_id=$1",[userId]);
}
describe('P04 billing ledger',()=>{
 beforeAll(async()=>{await migrate(loadConfig('migrate',{...env,DATABASE_URL:migrationUrl}));});
 afterAll(async()=>{await Promise.all([root.end(),pool.end()]);});
 it('accepts a current owned session for every user-facing billing query',async()=>{
  const userId=await fixture(),runId=randomUUID(),scope={userId,sessionId:randomUUID(),traceId:randomUUID()};
  await insertFixtureSession(root,userId,scope.sessionId);
  await runFact(userId,runId);
  expect((await billing.membership(scope)).membership.levelCode).toBe('free');
  expect((await billing.creditSummary(scope)).account.runAdmission).toBe('allowed');
  expect((await billing.quotaSummary(scope)).items).toEqual([expect.objectContaining({quotaType:'credits',limitAmount:10000000})]);
  expect(await billing.runUsage(scope,runId)).toMatchObject({runId,accountedCredits:2});
 });
 it.each(['revoked','expired session','expired access','mismatched user','suspended user','deleted user'] as const)('rejects %s for every user-facing billing query',async state=>{
  const userId=await fixture(),runId=randomUUID(),scope={userId,sessionId:randomUUID(),traceId:randomUUID()};
  await insertFixtureSession(root,state==='mismatched user'?await fixture():userId,scope.sessionId);
  await runFact(userId,runId);
  if(state==='revoked')await root.query('UPDATE user_sessions SET revoked_at=now() WHERE id=$1',[scope.sessionId]);
  if(state==='expired session')await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second',expires_at=now()-interval '1 second' WHERE id=$1",[scope.sessionId]);
  if(state==='expired access')await root.query("UPDATE user_sessions SET access_expires_at=now()-interval '1 second' WHERE id=$1",[scope.sessionId]);
  if(state==='suspended user')await root.query("UPDATE users SET status='suspended' WHERE id=$1",[userId]);
  if(state==='deleted user')await root.query("UPDATE users SET status='deleted',deleted_at=now() WHERE id=$1",[userId]);
  await expect(billing.membership(scope)).rejects.toMatchObject({statusCode:401,code:'AUTH_SESSION_EXPIRED'});
  await expect(billing.creditSummary(scope)).rejects.toMatchObject({statusCode:401,code:'AUTH_SESSION_EXPIRED'});
  await expect(billing.quotaSummary(scope)).rejects.toMatchObject({statusCode:401,code:'AUTH_SESSION_EXPIRED'});
  await expect(billing.runUsage(scope,runId)).rejects.toMatchObject({statusCode:401,code:'AUTH_SESSION_EXPIRED'});
 });
 it('creates App-compatible development account and separates monthly/permanent credits',async()=>{const user=await fixture();const scope={userId:user,sessionId:randomUUID(),traceId:randomUUID()};await insertFixtureSession(root,user,scope.sessionId);const x=await billing.membership(scope);expect(x.membership.levelCode).toBe('free');expect(x.monthlyCredit.quotaCredits).toBe(10000000);expect(x.permanentCredit.availableCredits).toBe(0);expect(x.account.runAdmission).toBe('allowed');});
 it('serializes concurrent reservations and replays idempotently',async()=>{const user=await fixture();const key=`test:${randomUUID()}`;const [a,b]=await Promise.all([billing.reserveCredits({userId:user,reservationKey:key,requestedCredits:7000000n}),billing.reserveCredits({userId:user,reservationKey:key,requestedCredits:7000000n})]);expect(a.reservationId).toBe(b.reservationId);const other=await billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:3000000n});expect(other.status).toBe('reserved');await expect(billing.reserveCredits({userId:user,reservationKey:key,requestedCredits:1n})).rejects.toMatchObject({code:'RESERVATION_CONFLICT'});await expect(billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:1n})).rejects.toMatchObject({code:'INSUFFICIENT_CREDITS'});});
 it('commit and release are one-time transitions',async()=>{const user=await fixture();const r=await billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:2n});expect((await billing.commitReservation(r.reservationId)).status).toBe('committed');expect((await billing.commitReservation(r.reservationId)).status).toBe('committed');const s=await billing.reserveCredits({userId:user,reservationKey:`test:${randomUUID()}`,requestedCredits:2n});expect((await billing.releaseReservation(s.reservationId)).status).toBe('released');expect((await billing.releaseReservation(s.reservationId)).status).toBe('released');});
 it('unknown provider measurement is uncovered and blocks admission',async()=>{const user=await fixture();const runId=randomUUID();await runFact(user,runId,true);const scope={userId:user,sessionId:randomUUID(),traceId:randomUUID()};await insertFixtureSession(root,user,scope.sessionId);const x=await billing.creditSummary(scope);expect(x.account.runAdmission).toBe('blocked_uncovered_credit');expect((await billing.runUsage(scope,runId)).settlementStatus).toBe('uncovered');await expect(billing.assertCanRun(user,1n)).rejects.toMatchObject({code:'BILLING_UNCOVERED_CREDIT'});});
 it('permanent grant is idempotent',async()=>{const user=await fixture();expect((await billing.grantPermanentCredits(user,5n,'admin_grant','fixture-grant')).granted).toBe(true);expect((await billing.grantPermanentCredits(user,5n,'admin_grant','fixture-grant')).granted).toBe(false);});
 it('rejects missing users before creating billing relations',async()=>{
  const userId=randomUUID();
  await expect(billing.grantEntitlement({userId,source:'fixture',grantKey:randomUUID()})).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  await expect(billing.grantPermanentCredits(userId,1n,'fixture',randomUUID())).rejects.toMatchObject({code:'USER_NOT_FOUND'});
  expect((await root.query('SELECT count(*)::int n FROM account_memberships WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
  expect((await root.query('SELECT count(*)::int n FROM provider_usage_measurements WHERE user_id=$1',[userId])).rows[0].n).toBe(0);
 });
 it('requires owned task and reservation references at billing write boundaries',async()=>{
  const userId=await fixture(),otherUserId=await fixture(),workspaceId=randomUUID(),taskId=randomUUID();
  await root.query("INSERT INTO workspaces(id,user_id,display_name,is_default,bootstrap_receipt_id) VALUES($1,$2,'billing-reference-fixture',true,$3)",[workspaceId,userId,randomUUID()]);
  await root.query("INSERT INTO tasks(trace_id,id,user_id,workspace_id,kind,queue,state) VALUES(gen_random_uuid()::text,$1,$2,$3,'demo.digest','content','queued')",[taskId,userId,workspaceId]);
  await expect(billing.reserveCredits({userId:otherUserId,taskId,reservationKey:randomUUID(),requestedCredits:1n})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await expect(billing.reserveCredits({userId,taskId:randomUUID(),reservationKey:randomUUID(),requestedCredits:1n})).rejects.toMatchObject({code:'TASK_NOT_FOUND'});
  await expect(billing.reserveCredits({userId,taskId,reservationKey:randomUUID(),requestedCredits:1n})).resolves.toMatchObject({status:'reserved'});
 });
 it('does not expose another account measurement',async()=>{
  const userId=await fixture(),otherUserId=await fixture(),runId=randomUUID();
  await runFact(userId,runId);
  await root.query("INSERT INTO provider_usage_measurements(measurement_id,user_id,run_id,usage_kind,measurement_status) VALUES($1,$2,$3,'owned','pending'),($4,$5,$3,'foreign','pending')",[randomUUID(),userId,runId,randomUUID(),otherUserId]);
  const scope={userId,sessionId:randomUUID(),traceId:randomUUID()};
  await insertFixtureSession(root,userId,scope.sessionId);
  const usage=await billing.runUsage(scope,runId);
  expect(usage.accountedCredits).toBe(2);expect(usage.measurements.map(x=>x.usageKind)).toEqual(['owned']);
  await expect(billing.runUsage({...scope,userId:otherUserId},runId)).rejects.toMatchObject({code:'AUTH_SESSION_EXPIRED'});
 });
});
