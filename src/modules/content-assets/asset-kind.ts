import {Type} from '@sinclair/typebox';

export const assetKinds = ['audio','image','file','creative'] as const;
export type AssetKind = typeof assetKinds[number];
export const AssetKindSchema = Type.Union(assetKinds.map(kind=>Type.Literal(kind)));

export function inferAssetKind(sourceKind?:string):AssetKind {
 switch(sourceKind?.toLowerCase()){
  case 'audio': case 'recording': return 'audio';
  case 'image': case 'photo': return 'image';
  case 'document': case 'file': case 'import': case 'pdf': return 'file';
  default: return 'creative';
 }
}
