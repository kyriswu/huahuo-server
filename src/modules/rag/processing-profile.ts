import type {AppConfig} from '../../config/config.js';
import type {KbSnapshot} from '../kb/types.js';
import {kbSnapshot} from '../kb/profile.js';
import type {EnabledDocumentExtractionConfig} from '../../config/document-extraction.js';
export interface DocumentParserSnapshot {sourceResourceId:string;parseRunId:string;extraction:EnabledDocumentExtractionConfig;}
export interface FileProcessingSnapshot {
 version:'file-processing';format:'text'|'markdown';keyword:KbSnapshot;
 parser?:DocumentParserSnapshot;
}
export function fileProcessingSnapshot(config:AppConfig,format:'text'|'markdown',context?:{sourceResourceId:string;parseRunId:string}):FileProcessingSnapshot{
 return {version:'file-processing',format,keyword:kbSnapshot(config,'document-keyword',format),
  ...(context&&config.documentExtraction.enabled?{parser:{...context,extraction:structuredClone(config.documentExtraction)}}:{})};
}
