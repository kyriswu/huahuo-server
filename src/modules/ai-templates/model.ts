import { Type, type Static } from '@sinclair/typebox';
import { Id, Strict, Text } from '../identity/schemas.js';
import { DomainError } from '../identity/store.js';

export const MaxSourceChars = 50_000;
export const MaxOutputChars = 10_000;
export const MaxPromptChars = 10_000;
export const MaxRenderedPromptChars = MaxPromptChars + 2_000;
export const SceneKeySchema = Type.Union([Type.Literal('content_asset_outline'), Type.Literal('editor_polish')]);
export type SceneKey = Static<typeof SceneKeySchema>;
export const ItemKeySchema = Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' });
const DisplayLimit = Type.Integer({ minimum: 1, maximum: 50 });
const itemFields = {
  itemKey: ItemKeySchema,
  title: Text(64),
  description: Type.String({ maxLength: 160 }),
  icon: Type.String({ maxLength: 24 }),
  enabled: Type.Boolean(),
};
const GroupSchema = Type.Object({
  ...itemFields,
  kind: Type.Literal('group'),
  displayLimit: DisplayLimit,
}, Strict);
const TemplateSchema = Type.Object({
  ...itemFields,
  kind: Type.Literal('template'),
  parentKey: Type.Union([ItemKeySchema, Type.Null()]),
  prompt: Type.String({ maxLength: MaxPromptChars }),
}, Strict);
export const CatalogSchema = Type.Object({
  title: Text(64),
  displayLimit: DisplayLimit,
  items: Type.Array(Type.Union([GroupSchema, TemplateSchema]), { maxItems: 50 }),
}, Strict);
export type Catalog = Static<typeof CatalogSchema>;
export type Template = Static<typeof TemplateSchema>;

const RunVariablesSchema = Type.Optional(Type.Record(
  Type.String({ pattern: '^[\\s\\S]*$' }), Type.String({ maxLength: MaxPromptChars }),
  { description: '按名称匹配提示词变量。值为字符串，支持空字符串。' },
));

export const RunRequestSchema = Type.Union([
  Type.Object({
    sceneKey: Type.Literal('content_asset_outline'), itemKey: ItemKeySchema,
    input: Type.Object({ contentAssetId: Id, sourceRevision: Id }, Strict),
    variables: RunVariablesSchema,
  }, Strict),
  Type.Object({
    sceneKey: Type.Literal('editor_polish'), itemKey: ItemKeySchema,
    input: Type.Object({ text: Text(MaxSourceChars) }, Strict),
    variables: RunVariablesSchema,
  }, Strict),
]);
export type RunRequest = Static<typeof RunRequestSchema>;

function hasInvalidText(value: string): boolean {
  return value.includes('\u0000') || /\p{Surrogate}/u.test(value);
}

export function validateRunVariables(variables: unknown): void {
  if (variables === undefined) return;
  if (variables === null || typeof variables !== 'object' || Array.isArray(variables)
      || Object.entries(variables).some(([name, value]) => typeof value !== 'string'
        || value.length > MaxPromptChars || hasInvalidText(name) || hasInvalidText(value))) {
    throw new DomainError(400, 'AI_TEMPLATE_VARIABLES_INVALID');
  }
}

function validateText(...values: string[]) {
  if (values.some(hasInvalidText)) {
    throw new DomainError(400, 'AI_TEMPLATE_TEXT_INVALID');
  }
}

export function validateCatalog(catalog: Catalog, publishing: boolean): void {
  validateText(catalog.title);
  const items = new Map(catalog.items.map(item => [item.itemKey, item]));
  if (items.size !== catalog.items.length) throw new DomainError(400, 'AI_TEMPLATE_ITEM_KEY_DUPLICATE');

  for (const item of catalog.items) {
    validateText(item.title, item.description, item.icon);
    if (item.kind === 'group') continue;
    validateText(item.prompt);
    const parent = item.parentKey === null ? undefined : items.get(item.parentKey);
    if (item.parentKey !== null && parent?.kind !== 'group') throw new DomainError(400, 'AI_TEMPLATE_PARENT_INVALID');
    if (publishing && item.enabled && (parent?.enabled ?? true) && !item.prompt.trim()) {
      throw new DomainError(400, 'AI_TEMPLATE_PROMPT_REQUIRED');
    }
  }
}

export function visibleTemplates(catalog: Catalog): Template[] {
  const groups = new Set(catalog.items.filter(item => item.kind === 'group' && item.enabled).map(item => item.itemKey));
  return catalog.items.filter((item): item is Template =>
    item.kind === 'template' && item.enabled && (item.parentKey === null || groups.has(item.parentKey)));
}

export function listCatalog(catalog: Catalog, parentKey?: string) {
  const templates = visibleTemplates(catalog);
  const item = catalog.items.find(candidate => candidate.itemKey === parentKey);
  const parent = item?.kind === 'group' ? item : undefined;
  if (parentKey !== undefined && (parent?.kind !== 'group' || !parent.enabled)) {
    throw new DomainError(404, 'AI_TEMPLATE_GROUP_NOT_FOUND');
  }
  const items = catalog.items.flatMap(item => {
    const { itemKey, kind, title, description, icon } = item;
    const display = { itemKey, kind, title, description, icon };
    if (item.kind === 'group') {
      const childCount = templates.filter(template => template.parentKey === itemKey).length;
      return item.enabled && childCount > 0 && parentKey === undefined ? [{ ...display, childCount }] : [];
    }
    return item.parentKey === (parentKey ?? null) && templates.includes(item) ? [{ ...display, childCount: 0 }] : [];
  });
  return { title: parent?.title ?? catalog.title, displayLimit: parent?.displayLimit ?? catalog.displayLimit, totalCount: items.length, items };
}
