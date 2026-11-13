import type {FastifyInstance} from 'fastify';
import type {IdentityService} from '../identity/service.js';
import {success} from '../../contracts/envelope.js';
import type {NoteIndexService} from './service.js';
/** Read-only index diagnostics; Note writes remain the sole indexing input. */
export function registerIngestionRoutes(app:FastifyInstance,identity:IdentityService,service:NoteIndexService){
 app.get<{Params:{workspaceId:string;noteId:string}}>('/api/v1/workspaces/:workspaceId/notes/:noteId/ingestions',{preHandler:async req=>{req.authScope=await identity.authenticate(req.headers.authorization,req.id);}},async req=>success(await service.listNoteJobs(req.authScope!,req.params.workspaceId,req.params.noteId),req.id));
}
