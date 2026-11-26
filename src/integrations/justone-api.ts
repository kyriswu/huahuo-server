import { ServiceHttpClient, readJsonResponse } from './http-client.js';
import { identifyPlatform, imageMarkdown, LinkError, plainText, type LinkNode, type LinkProvider, type Platform } from '../lib/link-extraction/index.js';
import { articleNodes } from '../lib/link-extraction/wechat.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const string = (value: unknown) => typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: string): LinkNode => ({ kind: 'markdown', value });
function gallery(description: string, urls: string[]) {
  const images = urls.map(src => imageMarkdown(src));
  if (!images.length || images.some(image => !image)) throw new LinkError('LINK_ACCESS_UNKNOWN');
  return [text(plainText(description)), ...images.map(text)];
}
function access(item: Record<string, unknown>) {
  const flagged = (key: string) => item[key] === true || item[key] === 1;
  if (['is_paid','is_pay','is_paywall'].some(flagged)) throw new LinkError('LINK_PAID_CONTENT');
  if (flagged('is_private') || flagged('is_prohibited')) throw new LinkError('LINK_PRIVATE');
  if (flagged('is_delete')) throw new LinkError('LINK_DELETED');
  if (flagged('is_preview') || flagged('is_partial')) throw new LinkError('LINK_ACCESS_UNKNOWN');
}

function mapBilibili(data: unknown, id: string) {
  const video = object(object(data).videoData), rights = object(video.rights);
  if (['pay','ugc_pay','ugc_pay_preview','arc_pay'].some(key => rights[key] === 1) || object(video.ugc_season).is_pay_season === true)
    throw new LinkError('LINK_PAID_CONTENT');
  if (video.state !== 0 || video.bvid !== id || rights.pay !== 0) throw new LinkError('LINK_ACCESS_UNKNOWN');
  const pages = list(video.pages).map(object).sort((a,b) => Number(a.page) - Number(b.page));
  if (!pages.length || pages.length !== video.videos || pages.some((page,i) => page.page !== i+1 || !Number.isSafeInteger(page.cid)))
    throw new LinkError('LINK_ACCESS_UNKNOWN');
  return { title: string(video.title), nodes: pages.map((p): LinkNode => ({
    kind:'media', format:'video', id:String(p.cid), title:string(p.part),
  })) };
}
function mapDouyin(data: unknown, id: string) {
  const item = object(object(data).aweme_detail);
  access(item);
  access(object(item.status));
  if (item.aweme_id !== id) throw new LinkError('LINK_ACCESS_UNKNOWN');
  const desc = string(item.desc), title = string(item.item_title) || desc || '抖音作品';
  if (item.aweme_type === 68) return {title, nodes:gallery(desc,list(item.images).map(i => string(list(object(i).url_list)[0])))};
  if (item.aweme_type !== 0) throw new LinkError('LINK_ACCESS_UNKNOWN');
  const url = string(list(object(object(item.video).play_addr).url_list)[0]);
  return {title, nodes:[{kind:'media',format:'video',id,url} satisfies LinkNode]};
}
function mapNote(data: unknown, id: string) {
  const item = list(data).flatMap(g => list(object(g).note_list)).map(object).find(note => note.id === id);
  if (!item) throw new LinkError('LINK_ACCESS_UNKNOWN');
  access(item);
  const desc = string(item.desc), title = string(item.title) || desc || '小红书笔记';
  if (item.type === 'video') return {title, nodes:[{kind:'media',format:'video',id,url:string(object(item.video).url)} satisfies LinkNode]};
  if (item.type !== 'normal') throw new LinkError('LINK_ACCESS_UNKNOWN');
  return {title, nodes:gallery(desc,list(item.images_list).map(i => string(object(i).url) || string(object(i).original)))};
}
const endpoints = {
  xiaohongshu:{ path:'xiaohongshu/get-note-detail/v1', key:'noteId', id:/\/(?:explore|discovery\/item)\/([a-f\d]{24})(?:\/|$)/iu },
  bilibili:{ path:'bilibili/get-video-detail/v2', key:'bvid', id:/\/video\/(BV[\da-zA-Z]+)(?:\/|$)/u },
  douyin:{ path:'douyin/get-video-detail/v2', key:'videoId', id:/\/(?:video|note|slides)\/(\d+)(?:\/|$)/u },
};
export class JustOneApiAdapter implements LinkProvider {
  private readonly http: ServiceHttpClient;
  constructor(private readonly token?: string, fetchImpl?: typeof fetch) {
    this.http = new ServiceHttpClient({fetchImpl});
  }
  private async get(path: string, key: string, value: string, signal: AbortSignal) {
    if (!this.token) throw new LinkError('LINK_PROVIDER_UNAVAILABLE');
    const url = new URL('/api/' + path, 'https://api.justoneapi.com');
    url.searchParams.set('token',this.token);
    url.searchParams.set(key,value);
    try {
      return await this.http.request(url,{signal},{timeoutMs:60_000},async response => {
        if (!response.ok) throw new LinkError('LINK_PROVIDER_UNAVAILABLE');
        const body = object(await readJsonResponse(response,4 * 1024 * 1024));
        if (body.code !== 0) throw new LinkError('LINK_PROVIDER_UNAVAILABLE');
        return body.data;
      });
    } catch (error) {
      if (signal.aborted || error instanceof Error && error.name === 'TimeoutError') throw new LinkError('LINK_EXTRACTION_TIMEOUT');
      throw new LinkError('LINK_PROVIDER_UNAVAILABLE');
    }
  }
  async resolve(platform: Platform, original: string, signal: AbortSignal) {
    if (platform === 'wechat') {
      const article = object(await this.get('weixin/get-article-detail/v6','articleUrl',original,signal));
      access(article);
      if (!string(article.html).trim()) throw new LinkError('LINK_ACCESS_UNKNOWN');
      return {title:string(article.title),nodes:articleNodes(string(article.html))};
    }
    if (platform === 'huahuo' || platform === 'xiaoyuzhou') throw new LinkError('LINK_SOURCE_UNAVAILABLE');
    const endpoint = endpoints[platform];
    let id = endpoint.id.exec(new URL(original).pathname)?.[1];
    if (!id) {
      const result = object(await this.get(platform + '/share-url-transfer/v1','shareUrl',original,signal));
      const target = string(result.redirect_url);
      if (!target || identifyPlatform(target) !== platform) throw new LinkError('LINK_ACCESS_UNKNOWN');
      id = endpoint.id.exec(new URL(target).pathname)?.[1];
    }
    if (!id) throw new LinkError('LINK_ACCESS_UNKNOWN');
    const data = await this.get(endpoint.path, endpoint.key, id, signal);
    if (platform === 'bilibili') return mapBilibili(data,id);
    if (platform === 'douyin') return mapDouyin(data,id);
    return mapNote(data,id);
  }
}
