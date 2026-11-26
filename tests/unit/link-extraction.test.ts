import { describe, expect, it, vi } from 'vitest';
import { identifyPlatform, LinkExtractor, type LinkProvider } from '../../src/lib/link-extraction/index.js';
import { JustOneApiAdapter } from '../../src/integrations/justone-api.js';

const signal = () => AbortSignal.timeout(5000);
const articleUrl = 'https://mp.weixin.qq.com/s/id?source=share';
function adapter(...results: unknown[]) {
  const fetchImpl = vi.fn(async () => Response.json({code:0,data:results.shift()}));
  return {fetchImpl,extractor:new LinkExtractor(new JustOneApiAdapter('fixture',fetchImpl))};
}

describe('synchronous link extraction', () => {
  it('matches whole hostnames without a network request', () => {
    expect(identifyPlatform('https://b23.tv/example')).toBe('bilibili');
    expect(identifyPlatform('https://xhslink.com/example')).toBe('xiaohongshu');
    expect(identifyPlatform('https://v.douyin.com/example')).toBe('douyin');
    expect(() => identifyPlatform('https://mp.weixin.qq.com.example.org/s')).toThrow('LINK_UNSUPPORTED');
    expect(() => identifyPlatform('https://id@mp.weixin.qq.com/s')).toThrow('LINK_UNSUPPORTED');
  });
  it('retains mixed article order, omits missing covers and never calls ASR', async () => {
    const {fetchImpl,extractor} = adapter({title:'文章',html:'<p>段 A</p><video></video><img data-src="https://img.example/a.jpg"><video poster="https://img.example/b.jpg"></video><p>段 B</p><script>noise</script>'});
    const result = await extractor.extract(articleUrl,signal());
    expect(result.markdown).toBe('段 A\n\n![](<https://img.example/a.jpg>)![](<https://img.example/b.jpg>)\n\n段 B');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL((fetchImpl.mock.calls[0] as unknown as [URL])[0]).searchParams.get('articleUrl')).toBe(articleUrl);
  });
  it('requires transcription for a video-only article and rejects paid previews before saving', async () => {
    const video = adapter({title:'视频',html:'<section><video poster="https://img.example/cover"></video></section>'});
    await expect(video.extractor.extract(articleUrl,signal())).rejects.toMatchObject({code:'LINK_ASR_UNAVAILABLE'});
    const preview = adapter({title:'试读',html:'<mp-pay-preview><p>试读片段</p></mp-pay-preview>'});
    await expect(preview.extractor.extract(articleUrl,signal())).rejects.toMatchObject({code:'LINK_PAID_CONTENT'});
  });
  it('resolves a short link through the injected provider and uses the gallery endpoint',async()=>{
    const id='1234567890abcdef12345678';
    const {extractor,fetchImpl}=adapter({redirect_url:'https://www.xiaohongshu.com/explore/'+id},[{note_list:[{id,title:'图文',desc:'正文',type:'normal',images_list:[{url:'https://img.example/a'}]}]}]);
    expect(await extractor.extract('https://xhslink.com/share',signal())).toMatchObject({title:'图文',markdown:'正文\n\n![](<https://img.example/a>)'});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('classifies restrictions before transcription',async()=>{
    const paid=adapter({videoData:{rights:{pay:1}}});
    await expect(paid.extractor.extract('https://www.bilibili.com/video/BV123',signal())).rejects.toMatchObject({userMessage:'付费内容不可导入'});
    const denied=adapter({aweme_detail:{status:{is_private:true}}});
    await expect(denied.extractor.extract('https://www.douyin.com/video/123',signal())).rejects.toMatchObject({code:'LINK_PRIVATE'});
    const video=adapter({aweme_detail:{aweme_type:0,aweme_id:'123'}});
    await expect(video.extractor.extract('https://www.douyin.com/video/123',signal())).rejects.toMatchObject({userMessage:'暂不可转写'});
  });
  it('keeps all Bilibili parts in source order across the media service boundary',async()=>{
    const mock=vi.fn(async()=>Response.json({code:0,data:{videoData:{title:'演讲',state:0,bvid:'BV123',rights:{pay:0},videos:2,pages:[{page:2,cid:22,part:'第二段'},{page:1,cid:11,part:'第一段'}]}}}));
    const media={audioFromVideo:vi.fn(async(node:{id:string})=>'audio/'+node.id),transcribe:vi.fn(async(url:string)=>url)};
    const extractor=new LinkExtractor(new JustOneApiAdapter('test',mock),{media});
    expect((await extractor.extract('https://www.bilibili.com/video/BV123?p=2',signal())).markdown).toBe('## 第一段\n\naudio/11\n\n## 第二段\n\naudio/22');
  });
  it('keeps first-party and Xiaoyuzhou links off the external supplier',async()=>{
    const provider: LinkProvider={resolve:vi.fn()};
    const extractor=new LinkExtractor(provider,{huahuoHost:'share.example'});
    for(const url of ['https://www.xiaoyuzhoufm.com/sample','https://share.example/sample']){
      await expect(extractor.extract(url,signal())).rejects.toMatchObject({code:'LINK_SOURCE_UNAVAILABLE'});
    }
    expect(provider.resolve).not.toHaveBeenCalled();
  });
});
