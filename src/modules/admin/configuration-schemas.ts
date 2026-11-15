import {Type} from '@sinclair/typebox';
import {Id,Strict,Text,Nullable} from '../identity/schemas.js';
export const NodeSchema=Type.Object({
 id:Id,name:Text(80),capabilities:Type.Array(Type.Union([Type.Literal('document'),Type.Literal('audio')]),{minItems:1,maxItems:2,uniqueItems:true}),
 resourceClass:Type.Union([Type.Literal('cpu'),Type.Literal('gpu')]),mode:Type.Union([Type.Literal('ecs'),Type.Literal('always-on')]),
 regionId:Nullable(Text(64)),instanceId:Nullable(Text(128)),privateIp:Nullable(Text(45)),baseUrl:Text(512),healthPath:Type.String({maxLength:256}),tokenEnv:Nullable(Text(90)),
 concurrency:Type.Integer({minimum:1,maximum:16}),idleSeconds:Type.Integer({minimum:1,maximum:3600}),startupSeconds:Type.Integer({minimum:10,maximum:3600}),queueSeconds:Type.Integer({minimum:10,maximum:86400}),enabled:Type.Boolean(),revision:Type.Integer({minimum:1}),
 documentApi:Type.Optional(Type.Object({mode:Type.Literal('async'),parameters:Nullable(Type.Record(Type.String(),Type.Unknown())),timeoutSeconds:Type.Integer({minimum:1,maximum:86520}),pollMs:Type.Integer({minimum:100,maximum:60000}),maxResponseBytes:Type.Integer({minimum:1024,maximum:67108864})},Strict)),
 eciFallback:Type.Optional(Nullable(Type.Object({vpcId:Text(128),securityGroupId:Text(128),vSwitchIds:Type.Array(Text(128),{minItems:1,maxItems:16}),instanceTypes:Type.Array(Text(128),{minItems:1,maxItems:4}),image:Text(512),acrInstanceId:Text(128),extraStorageGiB:Type.Integer({minimum:0,maximum:1000}),bucket:Text(63),keyPrefix:Text(200)},Strict))),
},Strict);
export const ConfigurationResponse=Type.Object({revision:Type.Integer(),values:Type.Record(Type.String(),Type.Unknown()),updatedAt:Type.String(),
 definitions:Type.Array(Type.Object({key:Type.String(),category:Type.String(),label:Type.String(),description:Type.String(),type:Type.String(),default:Type.Unknown(),min:Type.Optional(Type.Number()),max:Type.Optional(Type.Number()),options:Type.Optional(Type.Array(Type.String())),effect:Type.String()})),
 bootstrap:Type.Object({processingNodesEnabled:Type.Boolean(),cloudControlEnabled:Type.Boolean(),billingMode:Type.String(),uploadHardMaxBytes:Type.Integer(),environmentKeys:Type.Array(Type.String())}),
 billingPolicies:Type.Array(Type.Object({policy_version:Type.String(),mode:Type.String(),monthly_credit_limit:Type.String(),currency:Type.String()})),
});
