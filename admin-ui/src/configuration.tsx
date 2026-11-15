import {Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Skeleton, Switch, Tabs, Tag} from 'antd';
import {useCallback, useEffect, useState} from 'react';
import {AdminApiError, adminRequest, type AdminIdentity} from './session';
import {DocumentTrial} from './document-trial';

type Category='document'|'rag'|'tasks'|'storage'|'billing'|'features'|'deployment';
type SettingsCategory=Exclude<Category,'document'>;
type Values=Record<string,unknown>;
interface Definition {key:string;category:Category;label:string;description:string;type:'number'|'boolean'|'select'|'string';min?:number;max?:number;options?:string[];effect:string;}
interface Configuration {revision:number;values:Values;updatedAt:string;definitions:Definition[];bootstrap:{processingNodesEnabled:boolean;cloudControlEnabled:boolean;billingMode:string;uploadHardMaxBytes:number;environmentKeys:string[]};billingPolicies:{policy_version:string;mode:string;monthly_credit_limit:string;currency:string}[];}
interface DocumentApi {mode:'async';parameters:Record<string,unknown>|null;timeoutSeconds:number;pollMs:number;maxResponseBytes:number;}
const defaultDocumentApi=():DocumentApi=>({mode:'async',parameters:null,timeoutSeconds:3120,pollMs:2000,maxResponseBytes:67108864});
interface Node {id:string;name:string;capabilities:('document'|'audio')[];resourceClass:'cpu'|'gpu';mode:'ecs'|'always-on';regionId:string|null;instanceId:string|null;privateIp:string|null;baseUrl:string;healthPath:string;tokenEnv:string|null;concurrency:number;idleSeconds:number;startupSeconds:number;queueSeconds:number;enabled:boolean;revision:number;eciFallback?:Record<string,unknown>|null;documentApi?:DocumentApi;}
interface NodeStatus {state:'online'|'offline'|'starting'|'stopping'|'unknown';source:'ecs'|'eci'|'http';serviceReady:boolean|null;serviceStatus:'ready'|'unreachable'|'not_checked'|'not_running';canStart:boolean;checkedAt?:string;reason?:string;instanceStatus?:string;startup?:{taskId:string;state:string;error?:string}|null;}
const nodeStatusText=(status?:NodeStatus)=>status?({online:'在线',offline:'不在线',starting:'开机中',stopping:'停机中',unknown:'状态未知'})[status.state]:'检测中';
const nodeStatusDetail=(status?:NodeStatus)=>!status?'正在读取实例状态':status.state==='online'?`${status.source==='http'?'服务已运行':'实例已运行'} · ${status.serviceStatus==='ready'?'解析 API 可访问':status.serviceStatus==='not_checked'?'当前环境未启用解析 API 调用':'解析 API 暂不可达'}`:status.state==='starting'?'正在通过云端控制接口开机':status.state==='stopping'?'正在按空闲策略停机':status.state==='offline'?'实例或服务未运行':'无法确认实例状态，请检查查询权限和连接';
const labels:Record<Category,string>={document:'解析与模型',rag:'RAG 与检索',tasks:'任务策略',storage:'上传与容量',billing:'计费策略',features:'功能开关',deployment:'部署配置'};
const optionLabels:Record<string,string>={disabled:'关闭',async:'异步解析',sync:'同步解析',deterministic:'测试提供器（仅开发/测试）',llm:'LLM（尚未接入）',dify:'Dify（尚未接入）'};
const panel='rounded-xl border border-console-line bg-white p-5 sm:p-6';

function errorText(cause:unknown){
 if(cause instanceof AdminApiError){
  if(cause.code==='CONFIGURATION_CONFLICT')return '已有其他管理员更新此配置。请保留当前修改，刷新配置后重新核对并保存。';
  if(cause.code==='PROCESSING_NODE_IDENTITY_EXISTS')return '该 ECS 或服务地址已登记，请编辑已有节点。';
  if(cause.status===409)return '节点尚未排空。请先关闭“接收新任务”并等待已有任务结束；ECS 还需确认已节省停机后再修改。';
  if(cause.status===403)return '当前账号没有修改权限，或登录校验已失效。请重新登录后重试。';
  if(cause.status===400)return '配置未通过校验。请检查数值范围、完整 JSON、节点地址和密钥引用；不要填写密钥。';
  if(cause.status===503)return '配置依赖暂不可用。请检查对应的部署开关和节点凭据引用后重试。';
 }
 return '暂时无法保存或读取配置。请重试。';
}

function SettingsEditor({data,category,editable,save}:{data:Configuration;category:SettingsCategory;editable:boolean;save:(values:Values)=>Promise<void>}){
 const [form]=Form.useForm();const [saving,setSaving]=useState(false);const [error,setError]=useState<string>();const [saved,setSaved]=useState(false);const [dirty,setDirty]=useState(false);
 const fields=data.definitions.filter(d=>d.category===category);
 useEffect(()=>{form.setFieldsValue(Object.fromEntries(fields.map(d=>[d.key,data.values[d.key]])));setDirty(false);},[data,category,form]);
 async function submit(values:Values){
  setSaving(true);setError(undefined);setSaved(false);
  try{const patch:Values={};for(const d of fields){const value=values[d.key];patch[d.key]=value;}await save(patch);setSaved(true);setDirty(false);}
  catch(cause){setError(errorText(cause));}finally{setSaving(false);}
 }
 return <section className={panel} aria-label={labels[category]}>
  <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{labels[category]}</h2></div>
  {error&&<Alert className="mb-5" type="error" showIcon title={error}/>}
  {saved&&<Alert className="mb-5" type="success" showIcon title="配置已保存" description="新任务按页面标注的生效方式使用此版本。"/>}
  <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={!editable||saving} onValuesChange={()=>{setDirty(true);setSaved(false);}}>
   {fields.map(d=><Form.Item key={d.key} name={d.key} label={<span className="font-medium">{d.label}</span>} valuePropName={d.type==='boolean'?'checked':'value'} extra={<span className="block max-w-prose text-xs leading-5 text-console-muted">{d.description}<br/>生效：{d.effect}</span>} rules={d.type==='number'?[{required:true,message:'请填写有效数值。'}]:[]}>
    {d.type==='boolean'?<Switch checkedChildren="开启" unCheckedChildren="关闭"/>:d.type==='number'?<InputNumber min={d.min} max={d.max} precision={0} style={{width:360,maxWidth:'100%'}}/>:d.key==='billing.policyVersion'?<Select options={data.billingPolicies.map(p=>({value:p.policy_version,label:`${p.policy_version} · ${p.mode}`}))}/>:d.type==='select'?<Select options={d.options?.map(value=>({value,label:optionLabels[value]??value}))}/>:<Input/>}
   </Form.Item>)}
   {editable&&<div className="flex flex-wrap items-center gap-3 border-t border-console-line pt-5"><Button type="primary" htmlType="submit" loading={saving} disabled={!dirty}>保存{labels[category]}</Button><span className="text-xs text-console-muted">{dirty?'有未保存的修改':`配置版本 ${data.revision}`}</span></div>}
  </Form>
 </section>;
}

function NodeEditor({node,editable,cloudEnabled,refreshKey,onSave,onStart,onStatus}:{node:Node;editable:boolean;cloudEnabled:boolean;refreshKey:number;onSave:(node:Node,revision:number)=>Promise<void>;onStart:(id:string)=>Promise<{taskId:string;state:string}>;onStatus:(id:string,status:NodeStatus)=>void}){
 type Fields=Node&{eciFallbackJson:string;documentParametersJson:string};
 const [form]=Form.useForm<Fields>();const mode=Form.useWatch('mode',form)??node.mode;
 const resourceClass=Form.useWatch('resourceClass',form)??node.resourceClass,capabilities=Form.useWatch('capabilities',form)??node.capabilities;
 const [saving,setSaving]=useState(false);const [error,setError]=useState<string>();const [saved,setSaved]=useState(false);
 const [status,setStatus]=useState<NodeStatus>();const [statusAttempt,setStatusAttempt]=useState(0);const [starting,setStarting]=useState(false);
 useEffect(()=>{
  if(!node.name)return;
  setStatus(undefined);onStatus(node.id,{state:'unknown',source:node.mode==='ecs'?'ecs':'http',serviceReady:null,serviceStatus:'not_checked',canStart:false,reason:'STATUS_CHECKING'});
  const events=new EventSource(`/admin/api/v1/processing-nodes/${node.id}/events`);
  const update=(next:NodeStatus)=>{setStatus(next);onStatus(node.id,next);};
  events.addEventListener('update',event=>{try{update(JSON.parse((event as MessageEvent).data) as NodeStatus);}catch{setError('运行状态暂时无法读取，请刷新状态。');}});
  events.onerror=()=>update({state:'unknown',source:node.mode==='ecs'?'ecs':'http',serviceReady:null,serviceStatus:'not_checked',canStart:false,reason:'STATUS_CONNECTION_UNAVAILABLE'});
  const focused=()=>setStatusAttempt(n=>n+1);window.addEventListener('focus',focused);
  return()=>{events.close();window.removeEventListener('focus',focused);};
 },[node.id,node.name,node.mode,node.revision,refreshKey,statusAttempt,onStatus]);
 async function startNode(){setStarting(true);setError(undefined);try{const startup=await onStart(node.id);const next:NodeStatus={...status,state:'starting',source:status?.source??'ecs',serviceReady:false,serviceStatus:'not_running',canStart:false,startup};setStatus(next);onStatus(node.id,next);}catch(cause){setError(errorText(cause));}finally{setStarting(false);}}
 useEffect(()=>{form.resetFields();form.setFieldsValue({...node,documentApi:node.documentApi??defaultDocumentApi(),documentParametersJson:node.documentApi?.parameters?JSON.stringify(node.documentApi.parameters,null,2):'',eciFallbackJson:node.eciFallback?JSON.stringify(node.eciFallback,null,2):''});setError(undefined);},[node,form]);
 async function submit(values:Fields){
  setSaving(true);setError(undefined);setSaved(false);
  try{
   const {eciFallbackJson,documentParametersJson,documentApi,...fields}=values;
   const next:Node={...node,...fields,eciFallback:mode==='ecs'&&resourceClass==='gpu'&&capabilities.length===1&&capabilities[0]==='document'&&eciFallbackJson?.trim()?JSON.parse(eciFallbackJson):null,
    tokenEnv:values.tokenEnv?.trim()||null,regionId:mode==='ecs'?values.regionId:null,instanceId:mode==='ecs'?values.instanceId:null,privateIp:mode==='ecs'?new URL(values.baseUrl).hostname:null};
   if(capabilities.includes('document'))next.documentApi={...defaultDocumentApi(),...node.documentApi,...documentApi,mode:'async',parameters:documentParametersJson?.trim()?JSON.parse(documentParametersJson):null};
   else delete next.documentApi;
   await onSave(next,node.revision);setSaved(true);
  }catch(cause){setError(cause instanceof SyntaxError?'JSON 格式有误，请检查后重试。':errorText(cause));}finally{setSaving(false);}
 }
 return <section className={panel} aria-label="节点配置">
  <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">{node.name}</h2><Tag className="m-0 rounded-full" aria-label="运行方式">{node.mode==='ecs'?'按需启停':'常驻运行'}</Tag></div><div role="status" aria-live="polite"><Tag color={status?.state==='online'?'green':status?.state==='starting'?'processing':'default'}>{nodeStatusText(status)}</Tag></div></div>
  <p className="mb-6 text-sm leading-6 text-console-muted">{node.mode==='ecs'?'云端开机不受内网限制；解析 API 需在同一 VPC 内访问。':'直接调用已部署的 HTTP 服务，需要当前环境可达。'}解析参数默认沿用服务端配置。</p>
  {node.name&&<div className="mb-5 flex flex-wrap items-center gap-3">
   {node.mode==='ecs'&&<Button disabled={!editable||!cloudEnabled||!status?.canStart} loading={starting||status?.state==='starting'} onClick={()=>void startNode()}>{starting||status?.state==='starting'?'开机中':'开机'}</Button>}
   <Button onClick={()=>setStatusAttempt(n=>n+1)}>刷新状态</Button>
   <span className="text-xs text-console-muted">{nodeStatusDetail(status)}{status?.checkedAt&&` · 最后检查 ${new Date(status.checkedAt).toLocaleTimeString('zh-CN',{hour12:false})}`}</span>
  </div>}
  {node.mode==='ecs'&&!cloudEnabled&&<Alert className="mb-5 break-words" type="warning" showIcon title="当前部署未允许云端控制" description="请核对 RAM 凭据与 PROCESSING_NODES_CLOUD_CONTROL_ENABLED。解析 API 的内网可达性不影响云端开机权限。"/>}
  {status?.startup?.state==='failed'&&status.state!=='online'&&<Alert className="mb-5" type="error" showIcon title="上次开机未完成" description="当前状态以云端实例检查为准，可刷新状态后重试。"/>}
  {error&&<Alert className="mb-5" type="error" showIcon title={error}/>}{saved&&<Alert className="mb-5" type="success" title="节点配置已保存" showIcon/>}
  <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={!editable||saving} onValuesChange={()=>setSaved(false)}>
   <div className="grid gap-x-6 sm:grid-cols-2">
    <Form.Item name="name" label="节点名称" rules={[{required:true,whitespace:true,message:'请输入节点名称。'}]}><Input maxLength={80}/></Form.Item>
    {mode==='ecs'&&<Form.Item name="instanceId" label="ECS 实例 ID" rules={[{required:true,message:'请输入实例 ID。'}]}><Input placeholder="i-…"/></Form.Item>}
    <Form.Item name="baseUrl" label="服务地址" rules={[{required:true,message:'请输入完整 HTTP(S) 地址。'},{type:'url',message:'请输入完整 HTTP(S) 地址。'}]}><Input placeholder="http://172.18.102.103:8000"/></Form.Item>
    <Form.Item name="concurrency" label="整机并发" rules={[{required:true}]}><InputNumber min={1} max={16} precision={0} className="w-full"/></Form.Item>
    <Form.Item name="idleSeconds" label={mode==='ecs'?'空闲停机等待（秒）':'空闲等待（秒）'} extra={mode==='ecs'?'开机后或最后一个请求结束后计时，无排队及执行任务时自动停机。':undefined} rules={[{required:true}]}><InputNumber min={1} max={3600} precision={0} className="w-full"/></Form.Item>
   </div>
   <details className="mb-5 border-t border-console-line pt-4"><summary className="cursor-pointer text-sm font-medium">高级设置</summary>
    <div className="mt-5 grid gap-x-6 sm:grid-cols-2">
     <Form.Item name="enabled" label="参与自动调度" extra="允许新任务分配到此节点；机器运行状态由实际检查决定。" valuePropName="checked"><Checkbox>接收新任务</Checkbox></Form.Item>
     <Form.Item name="capabilities" label="处理类型" rules={[{required:true,message:'至少选择一种类型。'}]}><Checkbox.Group options={[{label:'文档',value:'document'},{label:'音频',value:'audio'}]}/></Form.Item>
     <Form.Item name="resourceClass" label="计算资源"><Select options={[{value:'cpu',label:'CPU'},{value:'gpu',label:'GPU'}]}/></Form.Item>
     <Form.Item name="mode" label="唤醒方式"><Select options={[{value:'ecs',label:'启动既有 ECS'},{value:'always-on',label:'无需唤醒，直接调用'}]}/></Form.Item>
     {mode==='ecs'&&<Form.Item name="regionId" label="地域" rules={[{required:true,message:'请输入地域。'}]}><Input placeholder="cn-beijing"/></Form.Item>}
     <Form.Item name="healthPath" label="健康检查路径"><Input placeholder="/health"/></Form.Item>
     <Form.Item name="tokenEnv" label="鉴权变量名（可选）" extra="填写 PROCESSING_NODE_TOKEN_ 开头的部署变量名。"><Input placeholder="PROCESSING_NODE_TOKEN_DOCUMENT" autoComplete="off"/></Form.Item>
     {([{key:'startupSeconds',label:'启动超时（秒）',min:10,max:3600},{key:'queueSeconds',label:'排队超时（秒）',min:10,max:86400}] as const).map(d=><Form.Item key={d.key} name={d.key} label={d.label} rules={[{required:true}]}><InputNumber min={d.min} max={d.max} precision={0} className="w-full"/></Form.Item>)}
     {capabilities.includes('document')&&<><p className="mb-5 text-xs leading-5 text-console-muted">异步提交，完成后由服务回调通知。</p><Form.Item name={['documentApi','timeoutSeconds']} label="解析请求超时（秒）" rules={[{required:true}]}><InputNumber min={1} max={86520} precision={0} className="w-full"/></Form.Item></>}
    </div>
    {capabilities.includes('document')&&<Form.Item name="documentParametersJson" label="覆盖服务提取参数（可选）" extra="留空使用服务端默认配置。填写时提交完整 JSON，仅对本节点生效。"><Input.TextArea rows={6} spellCheck={false} className="font-mono text-xs" placeholder="通常留空，无需填写"/></Form.Item>}
    {mode==='ecs'&&resourceClass==='gpu'&&capabilities.length===1&&capabilities[0]==='document'&&<Form.Item name="eciFallbackJson" label="A10 ECI 缺货回退（可选）" extra="留空关闭。仅在 ECS 明确缺货时按此配置新建 ECI，需提供镜像及网络信息。"><Input.TextArea rows={6} spellCheck={false} className="font-mono text-xs"/></Form.Item>}
    <p className="mb-3 break-all text-xs leading-5 text-console-muted">节点 {node.id} · 版本 {node.revision}</p>
    <p className="mb-4 text-xs leading-5 text-console-muted">已分配任务保留原节点和调用参数。修改机器地址、唤醒方式或并发前需先排空任务。音频协议尚未接入。</p>
   </details>
   {editable&&<Button type="primary" htmlType="submit" loading={saving}>保存节点配置</Button>}
  </Form>
 </section>;
}

export function ConfigurationPage({admin,csrfToken,onSessionExpired}:{admin?:AdminIdentity;csrfToken?:string;onSessionExpired?:()=>void}){
 const [data,setData]=useState<Configuration>();const [nodes,setNodes]=useState<Node[]>([]);const [selected,setSelected]=useState<Node>();const [tab,setTab]=useState('nodes');const [trialOpen,setTrialOpen]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState<string>();const [attempt,setAttempt]=useState(0);
 const editable=admin?.role==='superadmin'&&Boolean(csrfToken);
 const [nodeStatuses,setNodeStatuses]=useState<Record<string,NodeStatus>>({});
 const nodeStatusChanged=useCallback((id:string,status:NodeStatus)=>setNodeStatuses(current=>({...current,[id]:status})),[]);
 function failed(cause:unknown){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();setError(errorText(cause));}
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError(undefined);Promise.all([adminRequest<Configuration>('configuration',{signal:controller.signal}),adminRequest<{items:Node[]}>('processing-nodes',{signal:controller.signal})]).then(([config,list])=>{if(!controller.signal.aborted){setData(config);setNodes(list.items);setSelected(list.items[0]);setLoading(false);}},cause=>{if(!controller.signal.aborted){failed(cause);setLoading(false);}});return()=>controller.abort();},[attempt,onSessionExpired]);
 const headers={'Content-Type':'application/json','X-CSRF-Token':csrfToken??''};
 async function saveSettings(category:SettingsCategory,values:Values){try{const updated=await adminRequest<Pick<Configuration,'revision'|'values'|'updatedAt'>>(`configuration/${category}`,{method:'PUT',headers,body:JSON.stringify({revision:data!.revision,values})});setData(current=>current?{...current,...updated}:current);}catch(cause){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();throw cause;}}
 async function startNode(id:string){try{return await adminRequest<{taskId:string;state:string}>(`processing-nodes/${id}/start`,{method:'POST',headers});}catch(cause){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();throw cause;}}
 async function saveNode(node:Node,revision:number){try{const updated=await adminRequest<Node>(`processing-nodes/${node.id}`,{method:'PUT',headers,body:JSON.stringify({node,revision})});setNodes(current=>[...current.filter(n=>n.id!==updated.id),updated]);setSelected(updated);}catch(cause){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();throw cause;}}
 return <>
  <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">运行配置</h1><p className="mt-2 max-w-prose text-sm leading-6 text-console-muted">管理处理节点和业务策略。每次保存记录版本与修改审计。</p></div><Button loading={loading} onClick={()=>setAttempt(n=>n+1)}>刷新配置</Button></div>
  {error&&<Alert type="error" showIcon title={error} action={<Button size="small" onClick={()=>setAttempt(n=>n+1)}>重试</Button>}/>}
  {loading?<section className={panel}><Skeleton active paragraph={{rows:8}}/></section>:data&&<>
   {!editable&&<Alert type="info" showIcon title="当前为只读视图，修改配置需要超级管理员权限。"/>}
   <Tabs activeKey={tab} onChange={setTab} items={[{key:'nodes',label:'处理节点'},...Object.entries(labels).map(([key,label])=>({key,label}))]}/>
   {tab==='nodes'?<div className="grid items-start gap-5 xl:grid-cols-[17rem_minmax(0,1fr)]"><aside className={panel}>
    <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold">节点列表 · {nodes.length}</h2></div>
    <div className="grid gap-2">{nodes.map(n=><button key={n.id} type="button" onClick={()=>setSelected(n)} aria-pressed={selected?.id===n.id} className={`rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-console-accent ${selected?.id===n.id?'border-console-accent bg-console-accent-soft':'border-console-line hover:bg-console-canvas'}`}><span className="block break-words text-sm font-medium">{n.name}</span><span className="mt-1 block text-xs text-console-muted">{n.resourceClass.toUpperCase()} · {n.capabilities.map(c=>c==='document'?'文档':'音频').join(' / ')} · {nodeStatusText(nodeStatuses[n.id])}</span></button>)}</div>
    <p className="mt-5 text-xs leading-5 text-console-muted">实例状态与解析 API 连通性分别检查。节点清单随代码发布维护。</p>
   </aside>{selected?<NodeEditor key={selected.id} node={selected} editable={editable} cloudEnabled={data.bootstrap.cloudControlEnabled} refreshKey={attempt} onSave={saveNode} onStart={startNode} onStatus={nodeStatusChanged}/>:<section className={panel}><h2 className="font-semibold">尚未配置节点</h2><p className="mt-2 text-sm text-console-muted">节点清单由代码发布维护。</p></section>}</div>
   :tab==='deployment'?<div className="grid gap-5"><SettingsEditor data={data} category="deployment" editable={editable} save={values=>saveSettings('deployment',values)}/><section className={panel}><h2 className="mb-3 text-base font-semibold">保留在环境变量中的配置</h2><p className="mb-5 max-w-prose text-sm leading-6 text-console-muted">连接、凭据与部署总开关由部署环境提供。这里仅显示变量名，不读取或展示密钥；更新后需重建对应进程。</p><div className="grid gap-3 sm:grid-cols-2">{data.bootstrap.environmentKeys.map(key=><code key={key} className="break-all rounded-md bg-console-canvas px-3 py-2 text-xs">{key}</code>)}</div><dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-console-muted">部署计费模式</dt><dd className="mt-1">{data.bootstrap.billingMode}</dd></div><div><dt className="text-console-muted">HTTP 上传硬上限</dt><dd className="mt-1 tabular-nums">{data.bootstrap.uploadHardMaxBytes.toLocaleString()} 字节</dd></div></dl></section></div>
   :tab==='document'?<section className={panel}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">解析与模型</h2><Button disabled={!editable} onClick={()=>setTrialOpen(true)}>文档解析试用</Button></div><p className="mt-4 max-w-prose text-sm leading-6 text-console-muted">调用方式和提取参数随处理节点保存，默认使用已部署服务的配置。</p><Button className="mt-5" onClick={()=>setTab('nodes')}>管理处理节点</Button></section>:<SettingsEditor key={tab} data={data} category={tab as SettingsCategory} editable={editable} save={values=>saveSettings(tab as SettingsCategory,values)}/>}
  </>}
  <Modal title="文档解析试用" open={trialOpen} onCancel={()=>setTrialOpen(false)} footer={null} width={1040} styles={{body:{maxHeight:'calc(100dvh - 180px)',overflowY:'auto',paddingRight:8}}}>
   <DocumentTrial open={trialOpen} admin={admin} csrfToken={csrfToken} onSessionExpired={onSessionExpired} onOpenConfiguration={()=>{setTrialOpen(false);setTab('nodes');}}/>
  </Modal>
 </>;
}
