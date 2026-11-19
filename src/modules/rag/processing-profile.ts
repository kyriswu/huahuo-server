import type {AppConfig} from '../../config/config.js';
import type {KbSnapshot} from '../kb/types.js';
import {snapshotForSource} from '../kb/profile.js';
export interface DocumentParserSnapshot {sourceResourceId:string;parseRunId:string;}
export interface FileProcessingSnapshot {
 version:'file-processing';format:'text'|'markdown';keyword:KbSnapshot;
 parser?:DocumentParserSnapshot;
}
export function fileProcessingSnapshot(config:AppConfig,format:'text'|'markdown',context?:{sourceResourceId:string;parseRunId:string}):FileProcessingSnapshot{
 return {version:'file-processing',format,keyword:snapshotForSource(config,'file',format),
  ...(context?{parser:{...context}}:{})};
}
