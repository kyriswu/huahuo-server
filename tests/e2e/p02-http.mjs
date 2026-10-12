import assert from 'node:assert/strict';
const api=process.env.TEST_API_URL,admin=process.env.TEST_ADMIN_URL;
const req=async(base,path,method='GET',body,headers={})=>{
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json();return {status:r.status,data:data.data,error:data.error,headers:r.headers};
};
for(const base of [api,admin]){
 let ready=false;
 for(let n=0;n<30;n++){try{if((await req(base,'/health/ready')).status===200){ready=true;break;}}catch{/* startup */}await new Promise(r=>setTimeout(r,500));}
 assert(ready,'HTTP role readiness');
}
async function login(phone){
 const otp=await req(api,'/api/v1/auth/sms-code','POST',{phone,scene:'login'});assert.equal(otp.status,200);assert.equal(otp.data.providerMode,'mock');
 const result=await req(api,'/api/v1/auth/login','POST',{phone,smsRequestId:otp.data.smsRequestId,smsCode:otp.data.testCode,deviceId:'http-fixture',agreementAccepted:true,agreementVersion:'2026-08-20',privacyVersion:'2026-08-20',clientVersion:'p02-http'});
 assert.equal(result.status,200);return result.data;
}
const a=await login('13800008001'),b=await login('13800008002');
const auth=s=>({Authorization:'Bearer '+s.accessToken});
assert.equal((await req(api,'/api/v1/me/status','GET',undefined,auth(a))).data.user.userId,a.user.userId);
assert.equal((await req(api,'/api/v1/workspaces/'+b.workspace.workspaceId,'GET',undefined,auth(a))).status,404);
const updated=await req(api,'/api/v1/me/profile','PATCH',{displayName:'HTTP 测试用户'},{...auth(a),'X-Idempotency-Key':'http-profile'});assert.equal(updated.status,200);
assert.equal((await req(api,'/api/v1/me/profile','GET',undefined,auth(a))).data.profile.displayName,'HTTP 测试用户');
const fresh=await req(api,'/api/v1/auth/refresh','POST',{refreshToken:a.refreshToken});assert.equal(fresh.status,200);
assert.equal((await req(api,'/api/v1/auth/refresh','POST',{refreshToken:a.refreshToken})).status,401);
assert.equal((await req(api,'/api/v1/me/status','GET',undefined,auth(fresh.data))).status,401);
assert.equal((await req(admin,'/admin/api/v1/me','GET',undefined,auth(b))).status,401);
const logged=await req(admin,'/admin/api/v1/login','POST',{username:'e2eadmin',password:process.env.TEST_ADMIN_PASSWORD},{Origin:'http://admin.test'});assert.equal(logged.status,200);
const cookie=logged.headers.get('set-cookie').split(';')[0];
assert.equal((await req(admin,'/admin/api/v1/me','GET',undefined,{Cookie:cookie})).status,200);
assert.equal((await req(admin,'/admin/api/v1/logout','POST',undefined,{Cookie:cookie,Origin:'http://admin.test'})).status,403);
assert.equal((await req(admin,'/admin/api/v1/logout','POST',undefined,{Cookie:cookie,Origin:'http://admin.test','X-CSRF-Token':logged.data.csrfToken})).status,200);
assert.equal((await req(admin,'/admin/api/v1/me','GET',undefined,{Cookie:cookie})).status,401);
console.log('P02 HTTP: two isolated users, profile persistence, refresh reuse revocation, independent admin login/CSRF/logout passed (mock SMS).');
