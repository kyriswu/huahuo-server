import {Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Skeleton, Switch, Tabs, Tag} from 'antd';
import {useEffect, useState, type ReactNode} from 'react';
import {AdminApiError, adminRequest, type AdminIdentity} from './session';
import {DocumentTrial} from './document-trial';

type Category='document'|'rag'|'tasks'|'storage'|'billing'|'features';
type Values=Record<string,unknown>;
interface Definition {key:string;category:Category;label:string;description:string;type:'number'|'boolean'|'select'|'json'|'string';min?:number;max?:number;options?:string[];effect:string;}
interface Configuration {revision:number;values:Values;updatedAt:string;definitions:Definition[];bootstrap:{processingNodesEnabled:boolean;billingMode:string;uploadHardMaxBytes:number;environmentKeys:string[]};billingPolicies:{policy_version:string;mode:string;monthly_credit_limit:string;currency:string}[];}
interface Node {id:string;name:string;capabilities:('document'|'audio')[];resourceClass:'cpu'|'gpu';mode:'ecs'|'always-on';regionId:string|null;instanceId:string|null;privateIp:string|null;baseUrl:string;healthPath:string;tokenEnv:string|null;concurrency:number;idleSeconds:number;startupSeconds:number;queueSeconds:number;enabled:boolean;revision:number;eciFallback?:Record<string,unknown>|null;}
const labels:Record<Category,string>={document:'解析与模型',rag:'RAG 与检索',tasks:'任务策略',storage:'上传与容量',billing:'计费策略',features:'功能开关'};
const optionLabels:Record<string,string>={disabled:'关闭',async:'异步解析',sync:'同步解析',deterministic:'测试提供器（仅开发/测试）',llm:'LLM（尚未接入）',dify:'Dify（尚未接入）'};
const panel='rounded-xl border border-console-line bg-white p-5 sm:p-6';
const initialNode=():Node=>({id:crypto.randomUUID(),name:'',capabilities:['document'],resourceClass:'cpu',mode:'ecs',regionId:'cn-beijing',instanceId:null,privateIp:null,baseUrl:'',healthPath:'/health',tokenEnv:null,concurrency:1,idleSeconds:60,startupSeconds:600,queueSeconds:3600,enabled:false,revision:1});

function errorText(cause:unknown){
 if(cause instanceof AdminApiError){
  if(cause.code==='CONFIGURATION_CONFLICT')return '已有其他管理员更新此配置。请保留当前修改，刷新配置后重新核对并保存。';
  if(cause.code==='PROCESSING_NODE_IDENTITY_EXISTS')return '该 ECS 或服务地址已登记，请编辑已有节点。';
  if(cause.status===409)return '节点尚未排空。请先设为不在线并等待已有任务结束；ECS 还需确认已节省停机后再修改。';
  if(cause.status===403)return '当前账号没有修改权限，或登录校验已失效。请重新登录后重试。';
  if(cause.status===400)return '配置未通过校验。请检查数值范围、完整 JSON、节点地址和密钥引用；不要填写密钥。';
  if(cause.status===503)return '配置依赖暂不可用。请检查部署总开关和节点凭据引用后重试。';
 }
 return '暂时无法保存或读取配置。请重试。';
}

function SettingsEditor({data,category,editable,save,action}:{data:Configuration;category:Category;editable:boolean;save:(values:Values)=>Promise<void>;action?:ReactNode}){
 const [form]=Form.useForm();const [saving,setSaving]=useState(false);const [error,setError]=useState<string>();const [saved,setSaved]=useState(false);const [dirty,setDirty]=useState(false);
 const fields=data.definitions.filter(d=>d.category===category);
 useEffect(()=>{form.setFieldsValue(Object.fromEntries(fields.map(d=>[d.key,d.type==='json'?(data.values[d.key]===null?'':JSON.stringify(data.values[d.key],null,2)):data.values[d.key]])));setDirty(false);},[data,category,form]);
 async function submit(values:Values){
  setSaving(true);setError(undefined);setSaved(false);
  try{const patch:Values={};for(const d of fields){const value=values[d.key];patch[d.key]=d.type==='json'?(String(value??'').trim()?JSON.parse(String(value)):null):value;}await save(patch);setSaved(true);setDirty(false);}
  catch(cause){setError(cause instanceof SyntaxError?'JSON 格式有误，请检查引号、逗号和括号。':errorText(cause));}finally{setSaving(false);}
 }
 return <section className={panel} aria-label={labels[category]}>
  <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">{labels[category]}</h2>{action}</div>
  {error&&<Alert className="mb-5" type="error" showIcon title={error}/>}
  {saved&&<Alert className="mb-5" type="success" showIcon title="配置已保存" description="新任务按页面标注的生效方式使用此版本。"/>}
  <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={!editable||saving} onValuesChange={()=>{setDirty(true);setSaved(false);}}>
   {fields.map(d=><Form.Item key={d.key} name={d.key} label={<span className="font-medium">{d.label}</span>} valuePropName={d.type==='boolean'?'checked':'value'} extra={<span className="block max-w-prose text-xs leading-5 text-console-muted">{d.description}<br/>生效：{d.effect}</span>} rules={d.type==='number'?[{required:true,message:'请填写有效数值。'}]:[]}>
    {d.type==='boolean'?<Switch checkedChildren="开启" unCheckedChildren="关闭"/>:d.type==='number'?<InputNumber min={d.min} max={d.max} precision={0} style={{width:360,maxWidth:'100%'}}/>:d.type==='json'?<Input.TextArea rows={16} spellCheck={false} className="font-mono text-xs" placeholder="填写与当前服务匹配的完整提取 JSON"/>:d.key==='billing.policyVersion'?<Select options={data.billingPolicies.map(p=>({value:p.policy_version,label:`${p.policy_version} · ${p.mode}`}))}/>:d.type==='select'?<Select options={d.options?.map(value=>({value,label:optionLabels[value]??value}))}/>:<Input/>}
   </Form.Item>)}
   {editable&&<div className="flex flex-wrap items-center gap-3 border-t border-console-line pt-5"><Button type="primary" htmlType="submit" loading={saving} disabled={!dirty}>保存{labels[category]}</Button><span className="text-xs text-console-muted">{dirty?'有未保存的修改':`配置版本 ${data.revision}`}</span></div>}
  </Form>
 </section>;
}

function NodeEditor({node,editable,onSave}:{node:Node;editable:boolean;onSave:(node:Node,revision:number)=>Promise<void>}){
 const [form]=Form.useForm<Node&{eciFallbackJson:string}>();const mode=Form.useWatch('mode',form)??node.mode;const [saving,setSaving]=useState(false);const [error,setError]=useState<string>();const [saved,setSaved]=useState(false);
 useEffect(()=>{form.resetFields();form.setFieldsValue({...node,eciFallbackJson:node.eciFallback?JSON.stringify(node.eciFallback,null,2):''});setError(undefined);setSaved(false);},[node,form]);
 async function submit(values:Node&{eciFallbackJson?:string}){setSaving(true);setError(undefined);setSaved(false);try{const {eciFallbackJson,...fields}=values;const next={...node,...fields,eciFallback:eciFallbackJson?.trim()?JSON.parse(eciFallbackJson):null,tokenEnv:values.tokenEnv?.trim()||null,regionId:mode==='ecs'?values.regionId:null,instanceId:mode==='ecs'?values.instanceId:null,privateIp:mode==='ecs'?values.privateIp:null};await onSave(next,node.name?node.revision:0);setSaved(true);}catch(cause){setError(cause instanceof SyntaxError?'ECI 回退 JSON 格式有误，请检查后重试。':errorText(cause));}finally{setSaving(false);}}
 return <section className={panel} aria-label="节点配置">
  <div className="mb-5 flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{node.name||'登记处理节点'}</h2><Tag color={node.enabled?'green':'default'}>{node.enabled?'在线':'不在线'}</Tag></div>
  <p className="mb-6 break-all text-xs text-console-muted">{node.id} · 版本 {node.revision}</p>
  {error&&<Alert className="mb-5" type="error" showIcon title={error}/>}{saved&&<Alert className="mb-5" type="success" title="节点配置已保存" showIcon/>}
  <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} disabled={!editable||saving}>
   <div className="grid gap-x-6 sm:grid-cols-2">
    <Form.Item name="name" label="节点名称" rules={[{required:true,whitespace:true,message:'请输入节点名称。'}]}><Input maxLength={80}/></Form.Item>
    <Form.Item name="capabilities" label="处理类型" rules={[{required:true,message:'至少选择一种类型。'}]}><Checkbox.Group options={[{label:'文档',value:'document'},{label:'音频',value:'audio'}]}/></Form.Item>
    <Form.Item name="resourceClass" label="计算资源"><Select options={[{value:'cpu',label:'CPU'},{value:'gpu',label:'GPU'}]}/></Form.Item>
    <Form.Item name="mode" label="运行方式"><Select options={[{value:'ecs',label:'ECS 按需启停'},{value:'always-on',label:'常驻 HTTP 服务'}]}/></Form.Item>
    {mode==='ecs'&&<><Form.Item name="regionId" label="地域" rules={[{required:true}]}><Input placeholder="cn-beijing"/></Form.Item><Form.Item name="instanceId" label="ECS 实例 ID" rules={[{required:true}]}><Input placeholder="i-…"/></Form.Item><Form.Item name="privateIp" label="实例私网 IP" rules={[{required:true}]}><Input placeholder="172.18.102.103"/></Form.Item></>}
    <Form.Item name="baseUrl" label="服务地址" rules={[{required:true,message:'请输入完整 HTTP(S) 地址。'}]}><Input placeholder="http://172.18.102.103:8000"/></Form.Item>
    <Form.Item name="healthPath" label="健康检查路径"><Input placeholder="/health"/></Form.Item>
    <Form.Item name="tokenEnv" label="鉴权变量名" extra="只填写 PROCESSING_NODE_TOKEN_ 开头的部署变量名。"><Input placeholder="PROCESSING_NODE_TOKEN_DOCUMENT" autoComplete="off"/></Form.Item>
    {([{key:'concurrency',label:'整机并发',min:1,max:16},{key:'idleSeconds',label:'空闲停机等待（秒）',min:1,max:3600},{key:'startupSeconds',label:'启动超时（秒）',min:10,max:3600},{key:'queueSeconds',label:'排队超时（秒）',min:10,max:86400}] as const).map(d=><Form.Item key={d.key} name={d.key} label={d.label} rules={[{required:true}]}><InputNumber min={d.min} max={d.max} precision={0} className="w-full"/></Form.Item>)}
    <Form.Item name="enabled" label="节点状态" extra="在线表示接收新任务；不在线时已有任务继续处理。" valuePropName="checked"><Switch checkedChildren="在线" unCheckedChildren="不在线"/></Form.Item>
   </div>
   <details className="mb-5 rounded-lg border border-console-line p-4"><summary className="cursor-pointer text-sm font-medium">A10 ECI 回退配置（可选）</summary><p className="mt-3 mb-3 text-xs leading-5 text-console-muted">仅 GPU 文档 ECS 节点可用。留空关闭；原 ECS 明确缺货后才申请按量 A10 ECI。填写内网镜像、网络与存储参数，不填写密钥。</p><Form.Item name="eciFallbackJson" label="完整回退 JSON"><Input.TextArea rows={8} spellCheck={false} className="font-mono text-xs" placeholder={'{"vpcId":"vpc-…","securityGroupId":"sg-…","vSwitchIds":["vsw-…"],"instanceTypes":["ecs.gn7i-c8g1.2xlarge"],"image":"…-registry-vpc.cn-beijing.cr.aliyuncs.com/…","acrInstanceId":"cri-…","extraStorageGiB":40,"bucket":"…","keyPrefix":"huahuo"}'}/></Form.Item></details>
   <p className="mb-5 text-xs leading-5 text-console-muted">设为不在线后，已分配任务继续使用原节点。同一能力的节点须兼容当前完整请求配置，CPU/GPU 参数不会自动转换。地址、能力和并发等配置须在任务排空后修改；ECS 还须确认已节省停机。音频节点可登记，音频服务协议接入另行完成。</p>
   {editable&&<Button type="primary" htmlType="submit" loading={saving}>保存节点配置</Button>}
  </Form>
 </section>;
}

export function ConfigurationPage({admin,csrfToken,onSessionExpired}:{admin?:AdminIdentity;csrfToken?:string;onSessionExpired?:()=>void}){
 const [data,setData]=useState<Configuration>();const [nodes,setNodes]=useState<Node[]>([]);const [selected,setSelected]=useState<Node>();const [tab,setTab]=useState('nodes');const [trialOpen,setTrialOpen]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState<string>();const [attempt,setAttempt]=useState(0);
 const editable=admin?.role==='superadmin'&&Boolean(csrfToken);
 function failed(cause:unknown){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();setError(errorText(cause));}
 useEffect(()=>{const controller=new AbortController();setLoading(true);setError(undefined);Promise.all([adminRequest<Configuration>('configuration',{signal:controller.signal}),adminRequest<{items:Node[]}>('processing-nodes',{signal:controller.signal})]).then(([config,list])=>{if(!controller.signal.aborted){setData(config);setNodes(list.items);setSelected(list.items[0]);setLoading(false);}},cause=>{if(!controller.signal.aborted){failed(cause);setLoading(false);}});return()=>controller.abort();},[attempt,onSessionExpired]);
 const headers={'Content-Type':'application/json','X-CSRF-Token':csrfToken??''};
 async function saveSettings(category:Category,values:Values){try{const updated=await adminRequest<Pick<Configuration,'revision'|'values'|'updatedAt'>>(`configuration/${category}`,{method:'PUT',headers,body:JSON.stringify({revision:data!.revision,values})});setData(current=>current?{...current,...updated}:current);}catch(cause){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();throw cause;}}
 async function saveNode(node:Node,revision:number){try{const updated=await adminRequest<Node>(`processing-nodes/${node.id}`,{method:'PUT',headers,body:JSON.stringify({node,revision})});setNodes(current=>[...current.filter(n=>n.id!==updated.id),updated]);setSelected(updated);}catch(cause){if(cause instanceof AdminApiError&&cause.status===401)onSessionExpired?.();throw cause;}}
 return <>
  <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">运行配置</h1><p className="mt-2 max-w-prose text-sm leading-6 text-console-muted">管理处理节点和业务策略。每次保存记录版本与修改审计。</p></div><Button loading={loading} onClick={()=>setAttempt(n=>n+1)}>刷新配置</Button></div>
  {error&&<Alert type="error" showIcon title={error} action={<Button size="small" onClick={()=>setAttempt(n=>n+1)}>重试</Button>}/>}
  {loading?<section className={panel}><Skeleton active paragraph={{rows:8}}/></section>:data&&<>
   {!editable&&<Alert type="info" showIcon title="当前为只读视图，修改配置需要超级管理员权限。"/>}
   <Tabs activeKey={tab} onChange={setTab} items={[{key:'nodes',label:'处理节点'},...Object.entries(labels).map(([key,label])=>({key,label})),{key:'deployment',label:'部署配置'}]}/>
   {tab==='nodes'?<div className="grid items-start gap-5 xl:grid-cols-[17rem_minmax(0,1fr)]"><aside className={panel}>
    <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold">节点列表 · {nodes.length}</h2>{editable&&<Button size="small" onClick={()=>setSelected(initialNode())}>新增</Button>}</div>
    <div className="grid gap-2">{nodes.map(n=><button key={n.id} type="button" onClick={()=>setSelected(n)} aria-pressed={selected?.id===n.id} className={`rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-console-accent ${selected?.id===n.id?'border-console-accent bg-console-accent-soft':'border-console-line hover:bg-console-canvas'}`}><span className="block break-words text-sm font-medium">{n.name}</span><span className="mt-1 block text-xs text-console-muted">{n.resourceClass.toUpperCase()} · {n.capabilities.map(c=>c==='document'?'文档':'音频').join(' / ')} · {n.enabled?'在线':'不在线'}</span></button>)}</div>
    <p className="mt-5 text-xs leading-5 text-console-muted">部署总开关：{data.bootstrap.processingNodesEnabled?'已开启':'已关闭'}<br/>同一 ECS 只登记一次，各处理类型共用整机额度。此处显示登记状态，运行状态由调度器协调。</p>
   </aside>{selected?<NodeEditor key={selected.id} node={selected} editable={editable} onSave={saveNode}/>:<section className={panel}><h2 className="font-semibold">尚未登记节点</h2><p className="mt-2 text-sm text-console-muted">新增 CPU 或 GPU 节点，并选择处理类型。</p></section>}</div>
   :tab==='deployment'?<section className={panel}><h2 className="mb-3 text-base font-semibold">保留在环境变量中的配置</h2><p className="mb-5 max-w-prose text-sm leading-6 text-console-muted">连接、凭据与部署总开关由部署环境提供。这里仅显示变量名，不读取或展示密钥；更新后需重建对应进程。</p><div className="grid gap-3 sm:grid-cols-2">{data.bootstrap.environmentKeys.map(key=><code key={key} className="break-all rounded-md bg-console-canvas px-3 py-2 text-xs">{key}</code>)}</div><dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-console-muted">部署计费模式</dt><dd className="mt-1">{data.bootstrap.billingMode}</dd></div><div><dt className="text-console-muted">HTTP 上传硬上限</dt><dd className="mt-1 tabular-nums">{data.bootstrap.uploadHardMaxBytes.toLocaleString()} 字节</dd></div></dl></section>
   :<SettingsEditor key={tab} data={data} category={tab as Category} editable={editable} save={values=>saveSettings(tab as Category,values)} action={tab==='document'?<Button disabled={!editable} onClick={()=>setTrialOpen(true)}>文档解析试用</Button>:undefined}/>}
  </>}
  <Modal title="文档解析试用" open={trialOpen} onCancel={()=>setTrialOpen(false)} footer={null} width={1040} styles={{body:{maxHeight:'calc(100dvh - 180px)',overflowY:'auto',paddingRight:8}}}>
   <DocumentTrial open={trialOpen} admin={admin} csrfToken={csrfToken} onSessionExpired={onSessionExpired} onOpenConfiguration={()=>{setTrialOpen(false);setTab('document');}}/>
  </Modal>
 </>;
}
