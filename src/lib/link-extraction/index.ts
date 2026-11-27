import { DomainError } from '../domain-error.js';

const shortHosts = {
  xiaohongshu: ['xhslink.cn', 'xhslink.com', 'www.xhslink.com'],
  bilibili: ['b23.tv'],
  douyin: ['v.douyin.com'],
} as const;

export function isPlatformShortHost(platform: keyof typeof shortHosts, hostname: string): boolean {
  return (shortHosts[platform] as readonly string[]).includes(hostname);
}

const hosts = {
  xiaohongshu: ['www.xiaohongshu.com', 'xiaohongshu.com', ...shortHosts.xiaohongshu],
  bilibili: ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com', ...shortHosts.bilibili],
  douyin: ['www.douyin.com', 'douyin.com', 'www.iesdouyin.com', ...shortHosts.douyin],
  wechat: ['mp.weixin.qq.com'],
  xiaoyuzhou: ['www.xiaoyuzhoufm.com', 'xiaoyuzhoufm.com'],
} as const;
export type Platform = keyof typeof hosts | 'huahuo';
export function identifyPlatform(input: string, huahuoHost?: string): Platform {
  let url: URL;
  try { url = new URL(input); } catch { throw new LinkError('LINK_UNSUPPORTED'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password)
    throw new LinkError('LINK_UNSUPPORTED');
  for (const [platform, domains] of Object.entries(hosts)) {
    if ((domains as readonly string[]).includes(url.hostname)) return platform as Platform;
  }
  if (huahuoHost && url.hostname === huahuoHost) return 'huahuo';
  throw new LinkError('LINK_UNSUPPORTED');
}

const errors = {
  LINK_UNSUPPORTED: [400, '不支持该链接'],
  LINK_SOURCE_UNAVAILABLE: [503, '此来源暂不可导入'],
  LINK_PROVIDER_UNAVAILABLE: [503, '解析服务暂不可用'],
  LINK_ACCESS_UNKNOWN: [422, '暂无法确认内容可导入'],
  LINK_PAID_CONTENT: [422, '付费内容不可导入'],
  LINK_PRIVATE: [403, '内容访问受限'],
  LINK_DELETED: [404, '内容已失效'],
  LINK_ASR_UNAVAILABLE: [503, '暂不可转写'],
  LINK_EXTRACTION_TIMEOUT: [504, '链接解析超时'],
} as const;
export function linkFailureMessage(code: string): string {
  return Object.hasOwn(errors, code) ? errors[code as keyof typeof errors][1] : '链接导入失败';
}
export class LinkError extends DomainError {
  readonly userMessage: string;
  constructor(code: keyof typeof errors) {
    super(errors[code][0], code);
    this.userMessage = errors[code][1];
  }
}

export type LinkNode =
  | { kind: 'markdown'; value: string }
  | { kind: 'media'; id: string; title?: string; url?: string; format: 'audio' | 'video' };
export interface LinkProvider {
  resolve(platform: Platform, url: string, signal: AbortSignal): Promise<{ title: string; nodes: LinkNode[] }>;
}
export interface MediaServices {
  audioFromVideo(node: Extract<LinkNode, { kind: 'media' }>, signal: AbortSignal): Promise<string>;
  transcribe(audio: string, signal: AbortSignal): Promise<string>;
}

export class LinkExtractor {
  constructor(private readonly provider: LinkProvider, private readonly options: {
    huahuoHost?: string; huahuo?: LinkProvider; xiaoyuzhou?: LinkProvider; media?: MediaServices;
  } = {}) {}

  async extract(url: string, signal: AbortSignal) {
    const platform = identifyPlatform(url, this.options.huahuoHost);
    const adapter = platform === 'huahuo' || platform === 'xiaoyuzhou' ? this.options[platform] : this.provider;
    if (!adapter) throw new LinkError('LINK_SOURCE_UNAVAILABLE');
    const { title, nodes } = await adapter.resolve(platform, url, signal);
    const sections: string[] = [];
    let contentType: 'article' | 'video' | 'audio' = 'article';
    for (const node of nodes) {
      signal.throwIfAborted();
      if (node.kind === 'markdown') { sections.push(node.value); continue; }
      if (!this.options.media) throw new LinkError('LINK_ASR_UNAVAILABLE');
      const audio = node.format === 'video' ? await this.options.media.audioFromVideo(node, signal) : node.url;
      if (!audio) throw new LinkError('LINK_ACCESS_UNKNOWN');
      const transcript = await this.options.media.transcribe(audio, signal);
      if (!transcript.trim()) throw new LinkError('LINK_ACCESS_UNKNOWN');
      contentType = node.format;
      if (node.title) sections.push('## ' + plainText(node.title));
      sections.push(plainText(transcript));
    }
    signal.throwIfAborted();
    const markdown = sections.filter(Boolean).join('\n\n').trim();
    if (!markdown || !title.trim()) throw new LinkError('LINK_ACCESS_UNKNOWN');
    return { platform, title: [...title.trim()].slice(0, 240).join(''), contentType, markdown };
  }
}

export function plainText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}[\]()#+.!|~-]/gu, '\\$&');
}
export function imageMarkdown(value: string, alt = ''): string {
  let url: URL;
  try { url = new URL(value); } catch { return ''; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
  return '![' + plainText(alt.replace(/\s+/gu, ' ')) + '](<' + url.href.replace(/</gu,'%3C').replace(/>/gu,'%3E') + '>)';
}
