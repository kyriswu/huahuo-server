import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { imageMarkdown, LinkError, plainText, type LinkNode } from './index.js';

export function articleNodes(html: string): LinkNode[] {
  const videos: LinkNode[] = [];
  let hasArticleContent = false;
  function render(node: DefaultTreeAdapterTypes.ChildNode, depth: number): string {
    if (depth > 160) throw new LinkError('LINK_ACCESS_UNKNOWN');
    if ('value' in node) {
      if (node.value.trim()) hasArticleContent = true;
      return plainText(node.value.replace(/[\t\r\n]+/gu, ' '));
    }
    if (!('tagName' in node)) return '';
    const attr = (name: string) => node.attrs.find(a => a.name === name)?.value ?? '';
    const tag = node.tagName;
    if (tag === 'mp-pay-preview' || attr('id') === 'js_pay_preview') throw new LinkError('LINK_PAID_CONTENT');
    if (['script','style','nav','noscript','template','svg'].includes(tag) || node.attrs.some(a => a.name === 'hidden')) return '';
    if (tag === 'img') {
      const image = imageMarkdown(attr('data-src') || attr('src'), attr('alt'));
      if (!image) throw new LinkError('LINK_ACCESS_UNKNOWN');
      hasArticleContent = true;
      return image;
    }
    if (['video','mp-video','mp-common-videosnap','mpvideo'].includes(tag)
        || tag === 'iframe' && /video|player/iu.test(attr('class') + attr('src') + attr('data-src'))) {
      videos.push({ kind:'media', format:'video', id:attr('data-mpvid') || String(videos.length+1), url:attr('src') });
      return imageMarkdown(attr('poster') || attr('data-cover') || attr('data-poster') || attr('cover'));
    }
    if (tag === 'br') return '\n';
    const body = node.childNodes.map(n => render(n, depth + 1)).join('');
    if (/^h[1-6]$/u.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + body.trim() + '\n\n';
    if (tag === 'li') return '\n' + (node.parentNode && 'tagName' in node.parentNode && node.parentNode.tagName === 'ol' ? '1. ' : '- ') + body.trim();
    if (['p','section','div','ol','ul','blockquote'].includes(tag)) return '\n\n' + body + '\n\n';
    return body;
  }
  const markdown = parseFragment(html).childNodes.map(n => render(n, 0)).join('').replace(/\n{3,}/gu,'\n\n').trim();
  return videos.length && !hasArticleContent ? videos : [{kind:'markdown',value:markdown}];
}
