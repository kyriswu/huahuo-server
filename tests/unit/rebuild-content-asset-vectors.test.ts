import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error operational MJS module has no declaration file
import { rebuildContentAssetVectors } from '../../scripts/rebuild-content-asset-vectors.mjs';

function fixture() {
  const description=(id='123',data_type='FloatVector')=>({collectionID:id,schema:{fields:[{name:'dense_vector',data_type,type_params:[{key:'dim',value:'1024'}]}]}});
  const client={describeCollection:vi.fn().mockResolvedValue(description()),query:vi.fn().mockResolvedValue({data:[{'count(*)':0}]}),dropCollection:vi.fn().mockResolvedValue({})};
  const pool={query:vi.fn().mockResolvedValue({rows:[{builds:0,chunks:0,active_tasks:0}]})};
  const index={ensureReady:vi.fn(async()=>{client.describeCollection.mockResolvedValue(description('456','Float16Vector'));}),close:vi.fn()};
  const options={config:{appEnv:'test',milvus:{database:'test'},kb:{contentAssetCollection:'huahuo_content_asset',documentCollection:'huahuo_document'}},client,pool,createIndex:()=>index};
  return {options,client,pool,index};
}
describe('explicit derived-vector rebuild boundaries',()=>{
  it('only inventories by default and never drops or exports rows',async()=>{
    const {options,client,index}=fixture();
    expect(await rebuildContentAssetVectors(options)).toMatchObject({oldId:'123',logicalRows:0,backups:0,modelCalls:0,applied:false});
    expect(client.dropCollection).not.toHaveBeenCalled();expect(index.ensureReady).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(expect.objectContaining({collection_name:'huahuo_content_asset',output_fields:['count(*)']}));
  });
  it('requires the exact server identity and refuses metadata that would become stale',async()=>{
    const {options,client,pool}=fixture();
    await expect(rebuildContentAssetVectors({...options,discard:true,expectedId:'999'})).rejects.toThrow('CONTENT_ASSET_REBUILD_ID_MISMATCH');
    for(const metadata of [{builds:1,chunks:0,active_tasks:0},{builds:0,chunks:1,active_tasks:0},{builds:0,chunks:0,active_tasks:1}]){
      pool.query.mockResolvedValueOnce({rows:[metadata]});
      await expect(rebuildContentAssetVectors({...options,discard:true,expectedId:'123'})).rejects.toThrow('CONTENT_ASSET_REBUILD_REINDEX_PLAN_REQUIRED');
    }
    expect(client.dropCollection).not.toHaveBeenCalled();
  });
  it('recreates only the bound content asset collection and verifies FP16/1024 and zero rows',async()=>{
    const {options,client,index}=fixture();
    expect(await rebuildContentAssetVectors({...options,discard:true,expectedId:'123'})).toMatchObject({applied:true,oldId:'123',newId:'456',storage:'Float16Vector',dimensions:1024,newLogicalRows:0});
    expect(client.dropCollection).toHaveBeenCalledExactlyOnceWith({collection_name:'huahuo_content_asset'});
    expect(index.close).toHaveBeenCalledOnce();
  });
  it('refuses production targets and collection aliasing',async()=>{
    const {options,client}=fixture();
    await expect(rebuildContentAssetVectors({...options,config:{...options.config,appEnv:'production'},discard:true,expectedId:'123'})).rejects.toThrow('CONTENT_ASSET_REBUILD_TARGET_DENIED');
    expect(client.dropCollection).not.toHaveBeenCalled();
  });
});
