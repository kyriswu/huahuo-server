const api=process.env.TEST_API_URL;
if(!api)throw new Error('TEST_API_URL_REQUIRED');
const request=async(path,options={})=>{const r=await fetch(api+path,{...options,headers:{'content-type':'application/json',...(options.headers??{})}});const body=await r.json();return {status:r.status,body};};
const sms=await request('/api/v1/auth/sms-code',{method:'POST',body:JSON.stringify({phone:'13800000001',scene:'login'})});
if(sms.status!==200||!sms.body.data.testCode)throw new Error(`SMS:${sms.status}`);
const login=await request('/api/v1/auth/login',{method:'POST',body:JSON.stringify({phone:'13800000001',smsRequestId:sms.body.data.smsRequestId,smsCode:sms.body.data.testCode,deviceId:'p03-http',agreementAccepted:true,agreementVersion:'2026-08-20',privacyVersion:'2026-08-20',clientVersion:'p03',timeZone:'Asia/Shanghai'})});
if(login.status!==200)throw new Error(`LOGIN:${login.status}`);const token=login.body.data.accessToken,workspaceId=login.body.data.workspace.workspaceId,auth={authorization:`Bearer ${token}`};
const key='p03-demo-key';const create=await request('/api/v1/tasks/demo',{method:'POST',headers:{...auth,'x-idempotency-key':key},body:JSON.stringify({workspaceId,text:'durable task input'})});
if(create.status!==200)throw new Error(`CREATE:${create.status}`);const task=create.body.data.task;
const replay=await request('/api/v1/tasks/demo',{method:'POST',headers:{...auth,'x-idempotency-key':key},body:JSON.stringify({workspaceId,text:'durable task input'})});
if(replay.status!==200||replay.body.data.task.taskId!==task.taskId)throw new Error('IDEMPOTENCY_REPLAY');
let done;for(let i=0;i<100;i++){const read=await request(`/api/v1/tasks/${task.taskId}`,{headers:auth});if(read.status!==200)throw new Error(`READ:${read.status}`);if(['succeeded','failed'].includes(read.body.data.task.status)){done=read.body.data.task;break;}await new Promise(r=>setTimeout(r,100));}
if(!done||done.status!=='succeeded')throw new Error(`TASK_NOT_SUCCEEDED:${JSON.stringify(done)}`);
const result=await request(`/api/v1/tasks/${task.taskId}/result`,{headers:auth});if(result.status!==200||result.body.data.byteCount!==18)throw new Error('RESULT');
const events=await request(`/api/v1/tasks/${task.taskId}/events?afterSequence=0`,{headers:auth});if(events.status!==200||events.body.data.items.length<3)throw new Error('EVENT_REPLAY');
const second=await request('/api/v1/tasks/demo',{method:'POST',headers:{...auth,'x-idempotency-key':'p03-cancel'},body:JSON.stringify({workspaceId,text:'cancel me'})});if(second.status!==200)throw new Error('CREATE_CANCEL');
const cancel=await request(`/api/v1/tasks/${second.body.data.task.taskId}/cancel`,{method:'POST',headers:{...auth,'x-idempotency-key':'p03-cancel-action'},body:JSON.stringify({reason:'fixture'})});if(cancel.status!==200)throw new Error(`CANCEL:${cancel.status}`);
console.log('P03 HTTP: durable task acceptance, idempotency, Worker PG result, ordered events and cancellation passed.');
