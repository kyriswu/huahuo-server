import {readFileSync} from 'node:fs';
import {createDocumentExtractionConfig} from '../../src/config/document-extraction.js';

export function extractionConfig(mode:'sync'|'async'='async') {
  const parameters=JSON.parse(readFileSync(new URL('../../resources/document-extraction/kbxml-request.json',import.meta.url),'utf8'));
  return createDocumentExtractionConfig(mode,parameters,100);
}
