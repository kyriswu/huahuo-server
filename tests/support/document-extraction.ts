import type {ExtractionResponse,FileContext} from '../../src/integrations/document-extraction.js';
import {createHash} from 'node:crypto';
export const sampleContext:FileContext={source_resource_id:'5fc9971b-a472-530c-b97c-eb8813abf8d2',parse_run_id:'d886ed0c-9b25-4587-b313-6cee3ddc2f23'};
export const sampleImage='998d9ecb-45d2-5624-a050-9cfcadf99ae6';
export function sampleExtraction(context:FileContext=sampleContext,index=0,mime='application/pdf'):ExtractionResponse{
 const hash=createHash('sha1').update(Buffer.from(context.parse_run_id.replaceAll('-',''),'hex')).update(context.source_resource_id).digest().subarray(0,16);
 hash[6]=(hash[6]!&15)|80;hash[8]=(hash[8]!&63)|128;const hex=hash.toString('hex');
 const resourceId=context.source_resource_id===sampleContext.source_resource_id&&context.parse_run_id===sampleContext.parse_run_id?sampleImage:[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
 const content=`# Untyped document\n\nNative body 😀\n\n| Item | Amount |\n| --- | --- |\n| A | 3000000.00 |\n\n<KBIMAGE id="cd0c26c3-18ea-59dd-aa62-dd9fb5165d2d" page="1" ocr_status="unavailable" role="chart" uuid="${sampleImage}"><![CDATA[]]></KBIMAGE>\n\n<KBFORMULA id="a2939609-5925-5440-9ce2-700788315fc3" format="latex"><![CDATA[x^2]]></KBFORMULA>\n`;
 const image={resource_id:sampleImage,uuid:sampleImage,image_index:0,page_number:1,format:'jpeg',width:384,height:120,sha256:'31ef7a35c2fefcd9a932d0e10bd931602dc706dda99ccc4bbb2febc83ee00d00',bytes:10566,mime_type:'image/jpeg',bbox:null,ocr_status:'unavailable',coordinate_system:'source_defined_unknown',origin:'unknown',page_dimensions:null,ocr_errors:null};
 const result:ExtractionResponse={summary:{inputs:1,results:1,errors:0,remote_urls:0,pages_crawled:0,documents_downloaded:0},errors:[],results:[{
   content,mime_type:mime,metadata:{pages:{total_count:1,boundaries:[{byte_start:0,byte_end:24,page_number:1}]},additional:{native_first_routing:{routing:'legacy'}}},
   extraction_method:'native',tables:[{cells:[['Item','Amount'],['A','3000000.00']],page_number:1,grid:{rows:2,cols:2}}],counts:{pages:1,tables:1,images:1},
   pages:[{page_number:1,content,tables:[],image_indices:[0],is_blank:false}],quality_score:1,...context,content_format:'kb-markdown-v1',images:[image],chunks:null,
   kb:{version:1,blocks:[{id:'cd0c26c3-18ea-59dd-aa62-dd9fb5165d2d',kind:'image',...context,resource_id:sampleImage,source_content_byte_range:[10,20],attributes:{uuid:sampleImage},status:'retained'}],
    relationships:[],capability_gaps:[],uploaded_resources:[{...context,resource_id:sampleImage,uuid:sampleImage,bucket:'fixture-bucket',object_key:'fixture-resources/'+sampleImage,sha256:image.sha256,bytes:image.bytes,mime_type:image.mime_type,etag:'fixture-etag',page_number:1,reused:false}],
    dedicated_tags:['KBIMAGE','KBFORMULA'],tables_format:'markdown_or_existing_merge_html',source_offset_basis:'core_content_before_output_adapter'},input_index:index,
 }]};
 return JSON.parse(JSON.stringify(result).replaceAll(sampleImage,resourceId)) as ExtractionResponse;
}
