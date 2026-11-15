import {Alert,Button,Input,Radio,Skeleton,Tabs,Tag} from 'antd';
import {useEffect,useRef,useState} from 'react';
import {AdminApiError,adminRequest,type AdminIdentity} from './session';
interface TrialStatus {id:string;state:'running'|'completed'|'failed'|'cancelled';phase:string;fileName?:string;bytes?:number;configRevision:number;configHash?:string;nodeId?:string;metrics:Record<string,number>;error?:string;}
interface Capabilities {maxBytes:number;structuredEnabled:boolean;unavailableReason:'deployment_disabled'|'no_online_node'|null;retentionSeconds:number;onlineNodes:{id:string;name:string}[];configRevision:number;}
interface TrialOutput {state:string;error?:string;result:Record<string,unknown>|null;}
const stateNames={running:'处理中',completed:'完成',failed:'失败',cancelled:'已取消'};
const phases:Record<string,string>={preparing:'准备文件',downloading:'下载文件',parsing:'解析并收取结果',completed:'完成',failed:'失败',cancelled:'已取消'};
function message(cause:unknown){
 const code=cause instanceof AdminApiError?cause.code:typeof cause==='string'?cause:'';
 if(code==='ADMIN_TRIAL_BUSY')return '已有试用正在处理，请等待结束后再提交。';
 if(code==='ADMIN_TRIAL_PARSER_NOT_CONFIGURED'||/PROCESSING_NODE.*(?:DISABLED|UNAVAILABLE)/.test(code??''))return 'PDF / Office 解析尚未就绪，请先核对部署总开关和在线节点。';
 if(code==='ADMIN_TRIAL_FILE_TOO_LARGE')return '文件超过本窗口的大小限制，请换一个较小的文件。';
 if(/UNKNOWN|UNCERTAIN/.test(code??''))return '远端结果尚未确认，系统没有自动重发。请先核实原任务。';
 if(/SOURCE_HOST|SOURCE_URL|SOURCE_URI/.test(code??''))return '文件链接不符合现有下载规则，请检查地址和域名白名单，或直接上传文件。';
 if(cause instanceof AdminApiError&&cause.status===403)return '试用需要超级管理员权限，请重新确认当前账号。';
 if(/FILE.*(?:INVALID|MISMATCH|UNSUPPORTED)/.test(code??''))return '文件内容或格式不符合要求，请检查后重试。';
 return `试用未完成${code?'（'+code+'）':''}，请检查文件和解析服务。`;
}
export function DocumentTrial({open,admin,csrfToken,onSessionExpired,onOpenConfiguration}:{open:boolean;admin?:AdminIdentity;csrfToken?:string;onSessionExpired?:()=>void;onOpenConfiguration:()=>void}){
 const [cap,setCap]=useState<Capabilities>();const [loading,setLoading]=useState(true);const [source,setSource]=useState('upload');const [file,setFile]=useState<File>();const [url,setUrl]=useState('');
 const [id,setId]=useState<string>();
 const [job,setJob]=useState<TrialStatus>();const [output,setOutput]=useState<TrialOutput>();const [error,setError]=useState<string>();const [submitting,setSubmitting]=useState(false);const [cancelling,setCancelling]=useState(false);const [resultTab,setResultTab]=useState('markdown');const [refresh,setRefresh]=useState(0);const alive=useRef(true);
 const writable=admin?.role==='superadmin'&&Boolean(csrfToken);
 const fail=(cause:unknown)=>{if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();setError(message(cause));};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!open)return;if(!writable){setLoading(false);return;}const controller=new AbortController();setLoading(true);adminRequest<Capabilities>('document-trials/capabilities',{signal:controller.signal}).then(data=>{if(!controller.signal.aborted){setCap(data);setLoading(false);}},cause=>{if(!controller.signal.aborted){fail(cause);setLoading(false);}});return()=>controller.abort();},[open,writable,refresh,onSessionExpired]);
 useEffect(()=>{
  if(!id||!writable||!open)return;const controller=new AbortController();let events:EventSource|undefined;let fetched=false;
  async function update(status:TrialStatus){if(controller.signal.aborted)return;setJob(status);
   if(status.state==='completed'&&!fetched){fetched=true;events?.close();const result=await adminRequest<TrialOutput>('document-trials/'+id+'/result',{signal:controller.signal});if(!controller.signal.aborted)setOutput(result);}
   else if(status.state==='failed'||status.state==='cancelled'){events?.close();if(status.error)setError(message(status.error));}
  }
  async function connect(){try{
   const status=await adminRequest<TrialStatus>('document-trials/'+id,{signal:controller.signal});await update(status);if(controller.signal.aborted||status.state!=='running')return;
   events=new EventSource('/admin/api/v1/document-trials/'+id+'/events');events.addEventListener('update',event=>{try{void update(JSON.parse((event as MessageEvent).data) as TrialStatus).catch(fail);}catch{setError('进度通知暂时无法读取，请刷新状态。');}});
   events.onerror=()=>{events?.close();if(!controller.signal.aborted)setError('试用连接已中断，请刷新状态。');};
  }catch(cause){if(controller.signal.aborted)return;if(cause instanceof AdminApiError&&cause.status===404){setId(undefined);setJob(undefined);setOutput(undefined);setError('本次试用已结束，请重新开始。');}else fail(cause);}}
  void connect();return()=>{controller.abort();events?.close();};
 },[id,writable,refresh,onSessionExpired,open]);
 const headers={'X-CSRF-Token':csrfToken??''};
 async function submit(){
  if(!cap||!writable)return;setError(undefined);if(source==='upload'&&(!file||file.size>cap.maxBytes)){setError(!file?'请选择文件。':'文件超过大小限制。');return;}if(source==='url'&&!url.trim()){setError('请填写文件直链。');return;}
  setSubmitting(true);setOutput(undefined);setJob(undefined);
  try{
   const next=source==='upload'?await adminRequest<TrialStatus>('document-trials/upload?'+new URLSearchParams({fileName:file!.name,mimeType:file!.type||'application/octet-stream'}),{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:file!}):await adminRequest<TrialStatus>('document-trials',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({fileUrl:url.trim()})});
   if(!alive.current)return;setJob(next);setId(next.id);
  }catch(cause){if(alive.current)fail(cause);}finally{if(alive.current)setSubmitting(false);}
 }
 async function cancel(){if(!id)return;setCancelling(true);try{setJob(await adminRequest<TrialStatus>('document-trials/'+id,{method:'DELETE',headers}));}catch(cause){fail(cause);}finally{setCancelling(false);}}
 const raw=output?.result;const first=raw&&Array.isArray(raw.results)?raw.results[0] as {content?:string}|undefined:undefined;
 const markdown=first?.content??(typeof raw?.content==='string'?raw.content:'');
 function download(kind:'md'|'json'){const text=kind==='md'?markdown:JSON.stringify(raw,null,2);const link=document.createElement('a'),href=URL.createObjectURL(new Blob([text],{type:kind==='md'?'text/markdown;charset=utf-8':'application/json'}));link.href=href;link.download=(job?.fileName?.replace(/\.[^.]+$/,'')||'document')+'.'+kind;link.click();setTimeout(()=>URL.revokeObjectURL(href),1000);}
 const active=submitting||job?.state==='running';
 return <div className="grid min-w-0 gap-5 pt-2">
  <div><p className="max-w-prose text-sm leading-6 text-console-muted">使用已保存的配置直接试用解析服务，只查看临时结果。</p><p className="mt-1 text-xs leading-5 text-console-muted">关闭弹窗后试用仍会继续。刷新页面或服务重启后，请重新开始；解析节点需已启动且可访问。</p></div>
  {!writable&&<Alert type="info" showIcon title="试用需要超级管理员权限。"/>}
  {error&&<Alert type="error" showIcon title={error} action={<Button size="small" onClick={()=>setRefresh(n=>n+1)}>刷新状态</Button>}/>}
  {loading?<Skeleton active paragraph={{rows:5}}/>:writable&&cap&&<section>
   <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">选择文档</h2><span className="text-xs text-console-muted">配置版本 {cap.configRevision} · 在线节点 {cap.onlineNodes.length}</span></div>
   {!cap.structuredEnabled&&<div className="mb-5"><Alert type="info" showIcon title={cap.unavailableReason==='deployment_disabled'?'当前环境未连接远程解析节点':'尚无在线的文档节点'} description={<>TXT、Markdown、CSV 可以直接试用。{cap.unavailableReason==='deployment_disabled'?'PDF / Office 请在可达服务的内网环境开启部署总开关后验证。':<>请先将<button type="button" onClick={onOpenConfiguration} className="cursor-pointer underline">文档节点</button>设为在线。</>}</>}/></div>}
   <Radio.Group value={source} onChange={e=>setSource(e.target.value)} disabled={active} options={[{value:'upload',label:'上传文件'},{value:'url',label:'文件链接'}]}/>
   <div className="mt-5">{source==='upload'?<><label htmlFor="trial-file" className="mb-2 block text-sm font-medium">本地文件</label><input id="trial-file" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.markdown,.csv" disabled={active} onChange={e=>setFile(e.target.files?.[0])} className="block w-full rounded-lg border border-console-line p-3 text-sm file:mr-3 file:rounded-md file:border file:border-console-line file:bg-white file:px-3 file:py-1.5 file:text-console-ink focus-visible:outline-2"/>{file&&<p className="mt-2 break-all text-xs text-console-muted">{file.name} · {(file.size/1024/1024).toFixed(2)} MiB</p>}</>:<><label htmlFor="trial-url" className="mb-2 block text-sm font-medium">HTTP(S) 文件直链</label><Input id="trial-url" value={url} onChange={e=>setUrl(e.target.value)} disabled={active} placeholder="粘贴完整文件链接，保留签名查询参数" autoComplete="off"/></>}</div>
   <p className="mt-3 text-xs leading-5 text-console-muted">支持 PDF、Word、Excel、PPT、TXT、Markdown、CSV；本窗口上限 {(cap.maxBytes/1024/1024).toFixed(0)} MiB。结果临时保留 {Math.round(cap.retentionSeconds/60)} 分钟，服务重启后不保留。图片仍按当前解析服务配置上传 OSS，本窗口不登记为业务素材。</p>
   <div className="mt-5 flex flex-wrap gap-3"><Button type="primary" loading={submitting} disabled={job?.state==='running'} onClick={()=>void submit()}>开始试用</Button>{job?.state==='running'&&<Button onClick={()=>void cancel()} loading={cancelling}>取消本次试用</Button>}</div>
  </section>}
  {job&&<section className="border-t border-console-line pt-5" aria-live="polite"><div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">解析状态</h2><Tag color={job.state==='completed'?'green':job.state==='failed'?'red':'default'}>{stateNames[job.state]}</Tag><span className="text-sm text-console-muted">{phases[job.phase]??job.phase}</span></div>
   <p className="mt-2 break-all text-xs text-console-muted">{job.fileName??'正在读取文件'} · {job.id}</p>
   <dl className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{[['totalMs','总耗时'],['downloadMs','文件下载'],['parseMs',job.configHash?'解析请求（含图片上传）':'原生文字提取']].map(([key,label])=><div key={key}><dt className="text-xs text-console-muted">{label}</dt><dd className="mt-1 text-lg tabular-nums">{job.metrics[key!]===undefined?'—':(job.metrics[key!]!/1000).toFixed(3)+' 秒'}</dd></div>)}</dl>
  </section>}
  {raw&&<section className="min-w-0 border-t border-console-line pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">解析结果</h2><div className="flex gap-2"><Button onClick={()=>download('md')}>下载 Markdown</Button><Button onClick={()=>download('json')}>下载 JSON</Button></div></div><Tabs activeKey={resultTab} onChange={setResultTab} items={[{key:'markdown',label:'完整 Markdown'},{key:'json',label:'完整 JSON'}]}/><Input.TextArea aria-label={resultTab==='markdown'?'完整 Markdown 结果':'完整 JSON 结果'} readOnly rows={20} value={resultTab==='markdown'?markdown:JSON.stringify(raw,null,2)} className="font-mono text-xs"/></section>}
 </div>;
}
