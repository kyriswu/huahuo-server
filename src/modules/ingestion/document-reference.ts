export interface DocumentParseState {
  phase:'bound'|'intent'|'job'|'cancelling'|'cancelled'|'complete'|'failed'; requestId:string; fingerprint:string;
  jobId?:string; artifactUri?:string; canonicalUri?:string; manifestUri?:string;
  fileName?:string;mimeType?:string;retryFrom?:string;
  sourceUri?:string;startedAt?:number;timedOut?:boolean;
}

/** Shared durable format: a receipt must describe the same phase as its prefix. */
export function decodeDocumentReference(value:string|null):DocumentParseState|undefined{
  if(!value?.startsWith('xberg-'))return;
  const match=/^xberg-(bound|intent|job|cancelling|cancelled|complete|failed):([A-Za-z0-9_-]+)$/.exec(value);
  if(!match)throw new Error('DOCUMENT_EXTRACTION_STATE_INVALID');
  try{
    const state=JSON.parse(Buffer.from(match[2]!,'base64url').toString()) as DocumentParseState;
    if(state.phase!==match[1]||typeof state.requestId!=='string'||!state.requestId||!/^[a-f0-9]{64}$/.test(state.fingerprint)
      ||(state.jobId!==undefined&&(typeof state.jobId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(state.jobId)))
      ||(['job','cancelling'].includes(state.phase)&&!state.jobId))throw new Error();
    return state;
  }catch{throw new Error('DOCUMENT_EXTRACTION_STATE_INVALID');}
}

export function encodeDocumentReference(state:DocumentParseState):string{
  return `xberg-${state.phase}:`+Buffer.from(JSON.stringify(state)).toString('base64url');
}
