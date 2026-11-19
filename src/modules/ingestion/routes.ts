import { readTrustedScope } from '../identity/trusted-scope.js';
import type {FastifyInstance} from 'fastify';
import {success} from '../../contracts/envelope.js';
import type {ContentAssetIndexService} from './service.js';
/** Read-only index diagnostics; content asset writes remain the sole indexing input. */
export function registerIngestionRoutes(app:FastifyInstance,service:ContentAssetIndexService){
 app.get<{Params:{contentAssetId:string}}>('/api/v1/content-assets/:contentAssetId/ingestions',{preHandler:async req=>{req.authScope=readTrustedScope(req.headers,req.id);}},async req=>success(await service.listContentAssetJobs(req.authScope!,req.params.contentAssetId),req.id));
}
