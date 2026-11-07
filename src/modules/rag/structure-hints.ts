/** Source annotations from the existing enriched Markdown format. These ranges
 * suppress OCR-looking Markdown headings without changing body/order/offsets. */
export function ocrHeadingRanges(content:string,assets:ReadonlyArray<{ocrText?:string|null;captionText?:string|null}>=[]):Array<{sourceStart:number;sourceEnd:number}>{
  const ranges:Array<{sourceStart:number;sourceEnd:number}>=[];
  const unresolved=/<!-- mineru-unresolved-ocr -->/u.exec(content);
  if(unresolved)ranges.push({sourceStart:unresolved.index,sourceEnd:content.length});
  const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  for(const asset of assets)for(const [label,text]of [['图片文字',asset.ocrText],['图片描述',asset.captionText]] as const){
    if(!text)continue;
    for(const match of content.matchAll(new RegExp(escape(`${label}：${text}`),'gu')))ranges.push({sourceStart:match.index,sourceEnd:match.index+match[0].length});
  }
  return ranges;
}
