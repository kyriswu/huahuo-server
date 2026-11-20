import type { SceneKey, Template } from './model.js';

const placeholder = /\{\{([^{}]*)\}\}/gu;

export const systemPromptVariables = {
  content_asset_outline: ['templateTitle', 'sourceTitle'],
  editor_polish: ['templateTitle'],
} as const satisfies Record<SceneKey, readonly string[]>;

type VariableMatch = { name: string; start: number; end: number };

export function matchPromptVariables(prompt: string): VariableMatch[] {
  const variables: VariableMatch[] = [];
  for (const { 0: token, 1: value, index: start } of prompt.matchAll(placeholder)) {
    const name = value?.trim();
    if (name) variables.push({ name, start, end: start + token.length });
  }
  return variables;
}

export function renderPrompt(
  scene: SceneKey, template: Template, sourceTitle: string,
  variables: Readonly<Record<string, string>>, maxLength: number,
): string | undefined {
  const builtInNames = systemPromptVariables[scene];
  const values = { templateTitle: template.title, sourceTitle };
  const parts: string[] = [];
  let offset = 0;
  for (const { name, start, end } of matchPromptVariables(template.prompt)) {
    const builtIn = builtInNames.find(variable => variable === name);
    const replacement = builtIn === undefined
      ? (Object.hasOwn(variables, name) ? variables[name]! : '')
      : values[builtIn];
    parts.push(template.prompt.slice(offset, start), replacement);
    offset = end;
  }
  parts.push(template.prompt.slice(offset));

  // Trim and bound the result before joining, since a large value can recur.
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!.trimStart();
    parts[index] = part;
    if (part) break;
  }
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!.trimEnd();
    parts[index] = part;
    if (part) break;
  }
  if (parts.reduce((length, part) => length + part.length, 0) > maxLength) return;
  return parts.join('');
}
