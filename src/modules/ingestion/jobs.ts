import type pg from 'pg';
import type {AppConfig} from '../../config/config.js';
import type {Attempt} from '../tasks/engine.js';
import {KnowledgeIndexJobs,type KbDependencies} from '../kb/jobs.js';
export class ContentAssetIndexJobs extends KnowledgeIndexJobs {
 constructor(pool:pg.Pool,config:AppConfig,dependencies:KbDependencies={}){super(pool,config,dependencies);}
 async execute(attempt:Attempt){
  const input=(await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[attempt.task.input_id,attempt.task.user_id,attempt.task.workspace_id])).rows[0];
  if(!input)throw new Error('KB_INPUT_UNAVAILABLE');
  const {buildId}=JSON.parse(String(input.body)) as {buildId:string};return this.executeBuild(buildId,attempt,'content_asset');
 }
 async executeCleanup(attempt:Attempt){const row=(await this.pool.query('SELECT body FROM task_inputs WHERE id=$1 AND user_id=$2 AND workspace_id=$3',[attempt.task.input_id,attempt.task.user_id,attempt.task.workspace_id])).rows[0];if(!row)throw new Error('KB_INPUT_UNAVAILABLE');const {contentAssetId}=JSON.parse(String(row.body)) as {contentAssetId:string};return this.cleanup('content_asset',contentAssetId,attempt);}
}
