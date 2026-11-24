import { Type } from '@sinclair/typebox';

export const contentStatuses = ['draft', 'processing', 'ready', 'failed'] as const;
export type ContentStatus = typeof contentStatuses[number];

export const ContentStatusSchema = Type.Union(contentStatuses.map(status => Type.Literal(status)));
