import { Type } from '@sinclair/typebox';
import { Strict } from '../modules/identity/schemas.js';

export const TocStatusSchema = Type.Union([Type.Literal('pending'), Type.Literal('ready'), Type.Literal('failed')]);
export const SectionIdSchema = Type.String({ pattern: '^section-(?:[a-f0-9]{20}|preamble|body)$' });
const sectionFields = {
  sectionId: SectionIdSchema,
  kind: Type.Union([Type.Literal('heading'), Type.Literal('preamble'), Type.Literal('body')]),
  title: Type.String(),
  sourceStart: Type.Integer({ minimum: 0 }),
  sourceEnd: Type.Integer({ minimum: 0 }),
};
const TocItemSchema = Type.Recursive(Self => Type.Object({
  ...sectionFields,
  level: Type.Integer({ minimum: 0, maximum: 6 }),
  anchor: Type.String(),
  headingPath: Type.Array(Type.String()),
  children: Type.Array(Self),
}, Strict), { $id: 'DocumentTocItem' });

export const TocFields = {
  toc: Type.Union([Type.Array(TocItemSchema), Type.Null()]),
  tocStatus: TocStatusSchema,
  offsetUnit: Type.Literal('utf16'),
};
export const DocumentSectionSchema = Type.Object({
  ...sectionFields,
  documentVersion: Type.String(),
  offsetUnit: Type.Literal('utf16'),
  format: Type.Union([Type.Literal('markdown'), Type.Literal('text')]),
  content: Type.String(),
}, Strict);
