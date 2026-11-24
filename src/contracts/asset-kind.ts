import { Type } from '@sinclair/typebox';

export const assetKinds = ['audio', 'image', 'file', 'creative', 'link'] as const;
export type AssetKind = typeof assetKinds[number];

export const AssetKindSchema = Type.Union(assetKinds.map(kind => Type.Literal(kind)));
export const AssetKindsSchema = Type.Array(AssetKindSchema, { maxItems: assetKinds.length });
