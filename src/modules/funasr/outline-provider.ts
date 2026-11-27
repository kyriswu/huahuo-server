import type { RecordingOutlineSettings } from '../../config/recording-outline.js';
import { readJsonResponse, ServiceHttpClient } from '../../integrations/http-client.js';
import { MaxOutputChars } from '../ai-templates/model.js';
import { RunTimeoutMs } from '../ai-templates/runs.js';
import { type RecordingOutlineProvider, OutlineError } from './recording-outline.js';

export class ServiceRecordingOutlineProvider implements RecordingOutlineProvider {
  constructor(private readonly settings: RecordingOutlineSettings,
    private readonly http = new ServiceHttpClient({dependency:'agent',operation:'recording-outline'})) {}

  generate(runId: string, input: {text: string; prompt: string}, signal: AbortSignal) {
    return this.http.request(this.settings.url,{
      method:'POST',signal,headers:{authorization:'Bearer '+this.settings.token,'content-type':'application/json',
        accept:'application/json','x-idempotency-key':runId},body:JSON.stringify({...input,stream:false}),
    },{timeoutMs:RunTimeoutMs},async response => {
      // A rejected request did not execute. Timeout, transport and gateway errors may have executed.
      if ([401,403,404,422,429].includes(response.status)) throw new OutlineError('RECORDING_OUTLINE_PROVIDER_REJECTED');
      if (!response.ok) throw new OutlineError('RECORDING_OUTLINE_OUTCOME_UNKNOWN',true);
      const result = await readJsonResponse(response,MaxOutputChars * 6 + 512);
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') {
        throw new OutlineError('AI_TEMPLATE_AGENT_RESPONSE_INVALID');
      }
      return result.text;
    });
  }
}
