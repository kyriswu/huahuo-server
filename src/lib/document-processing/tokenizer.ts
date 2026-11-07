import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Tokenizer } from '@huggingface/tokenizers';
import { DocumentProcessingError, type TokenCounter } from './types.js';

export interface ModelTokenizerOptions { model: string; tokenizerPath: string; tokenizerConfigPath: string; maxInputTokens: number; expectedSha256?: string; expectedConfigSha256?: string; }

/** Loads operator-provisioned model files; never silently downloads or estimates. */
export async function loadModelTokenizer(options: ModelTokenizerOptions): Promise<TokenCounter> {
  if (!options.model || !options.tokenizerPath || !options.tokenizerConfigPath || !Number.isInteger(options.maxInputTokens) || options.maxInputTokens < 1) throw new DocumentProcessingError('TOKENIZER_CONFIG_MISSING', 'Model tokenizer files and input limit must be configured');
  let jsonBytes: Buffer; let configBytes: Buffer;
  try { [jsonBytes, configBytes] = await Promise.all([readFile(options.tokenizerPath), readFile(options.tokenizerConfigPath)]); }
  catch { throw new DocumentProcessingError('TOKENIZER_FILES_UNAVAILABLE', 'Configured model tokenizer files are not readable'); }
  const hash = createHash('sha256').update(jsonBytes).digest('hex');
  const configHash = createHash('sha256').update(configBytes).digest('hex');
  if (options.expectedSha256 && hash !== options.expectedSha256) throw new DocumentProcessingError('TOKENIZER_HASH_MISMATCH', 'Tokenizer does not match the configured revision');
  if(options.expectedConfigSha256&&configHash!==options.expectedConfigSha256)throw new DocumentProcessingError('TOKENIZER_HASH_MISMATCH','Tokenizer configuration changed');
  let tokenizer: Tokenizer;
  try { tokenizer = new Tokenizer(JSON.parse(jsonBytes.toString('utf8')) as object, JSON.parse(configBytes.toString('utf8')) as object); }
  catch { throw new DocumentProcessingError('TOKENIZER_FILES_INVALID', 'Model tokenizer configuration is invalid'); }
  return { id: `${options.model}:hf-tokenizers-v0.2.0:${hash}:${configHash}`, model: options.model, maxInputTokens: options.maxInputTokens, count: text => tokenizer.encode(text, { add_special_tokens: true }).ids.length };
}
