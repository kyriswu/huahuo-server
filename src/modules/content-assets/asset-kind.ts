import type { AssetKind } from '../../contracts/asset-kind.js';

export function inferAssetKind(sourceKind?:string):AssetKind {
 switch(sourceKind?.trim().toLowerCase()){
  case 'audio': case 'recording': return 'audio';
  case 'image': case 'photo': return 'image';
  case 'document': case 'file': case 'import': case 'pdf': return 'file';
  case 'link': return 'link';
  default: return 'creative';
 }
}
