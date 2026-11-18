CREATE TABLE public.ai_template_scenes (
  scene_key text PRIMARY KEY CHECK (scene_key IN ('note_outline', 'editor_polish')),
  draft jsonb NOT NULL,
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_revision integer NOT NULL DEFAULT 1 CHECK (published_revision > 0)
);

CREATE TABLE public.ai_template_versions (
  scene_key text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  catalog jsonb NOT NULL,
  published_by uuid,
  restored_from integer,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scene_key, revision)
);

CREATE VIEW public.ai_template_published AS
SELECT s.scene_key, v.revision, v.catalog
FROM public.ai_template_scenes s
JOIN public.ai_template_versions v ON v.scene_key = s.scene_key AND v.revision = s.published_revision;

CREATE TABLE public.ai_template_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  scene_key text NOT NULL CHECK (scene_key IN ('note_outline', 'editor_polish')),
  item_key text NOT NULL,
  template_version integer NOT NULL,
  note_id uuid,
  source_revision uuid,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed')),
  result_text text,
  error_code text,
  error_status integer,
  trace_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (user_id, workspace_id, idempotency_key),
  CHECK ((scene_key = 'note_outline' AND note_id IS NOT NULL AND source_revision IS NOT NULL)
    OR (scene_key = 'editor_polish' AND note_id IS NULL AND source_revision IS NULL)),
  CHECK ((state = 'running' AND finished_at IS NULL AND result_text IS NULL AND error_code IS NULL AND error_status IS NULL)
    OR (state = 'succeeded' AND finished_at IS NOT NULL AND result_text IS NOT NULL AND error_code IS NULL AND error_status IS NULL)
    OR (state = 'failed' AND finished_at IS NOT NULL AND result_text IS NULL AND error_code IS NOT NULL AND error_status IS NOT NULL))
);

CREATE INDEX ai_template_outline_results_idx
ON public.ai_template_runs (workspace_id, note_id, source_revision, user_id, item_key, finished_at DESC, id DESC)
WHERE scene_key = 'note_outline' AND state = 'succeeded';

GRANT SELECT, UPDATE ON public.ai_template_scenes TO huahuo_admin;
GRANT SELECT, INSERT ON public.ai_template_versions TO huahuo_admin;
GRANT SELECT ON public.ai_template_published TO huahuo_api;
GRANT SELECT, INSERT, UPDATE ON public.ai_template_runs TO huahuo_api;

WITH inserted AS (
  INSERT INTO public.ai_template_scenes(scene_key, draft) VALUES
    ('note_outline', $catalog$
{
  "title": "切换模版", "displayLimit": 9,
  "items": [
    {"itemKey": "smart_outline", "kind": "template", "title": "智能纲要", "description": "自动匹配纲要", "icon": "📚", "enabled": true, "parentKey": null, "prompt": "先判断原文主要属于灵感、复盘、客户沟通、会议、访谈、学习或创作中的哪一类，按该类材料最合适的结构整理总览和要点。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "inspiration", "kind": "template", "title": "灵感记录", "description": "记想法与疑问", "icon": "💡", "enabled": true, "parentKey": null, "prompt": "提炼触发灵感的材料、核心想法、疑问和可以验证的下一步。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "personal_account", "kind": "template", "title": "个人自述", "description": "讲经历与感受", "icon": "📝", "enabled": true, "parentKey": null, "prompt": "按叙事顺序梳理人物经历、转折、表达出的感受和回顾。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "personal_review", "kind": "template", "title": "个人复盘", "description": "找原因与对策", "icon": "📒", "enabled": true, "parentKey": null, "prompt": "按目标、发生了什么、原因、经验和后续行动组织内容。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "customer_communication", "kind": "template", "title": "客户沟通", "description": "理需求、定方案", "icon": "💼", "enabled": true, "parentKey": null, "prompt": "整理客户背景、明确需求、限制、讨论过的方案、双方共识和待确认事项。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "work_meeting", "kind": "template", "title": "工作会议", "description": "记决定与分工", "icon": "👩🏻‍💻", "enabled": true, "parentKey": null, "prompt": "整理会议主题、讨论要点、决议和行动项，保留原文明确的负责人和截止时间。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "interview", "kind": "template", "title": "人物访谈", "description": "留故事与原话", "icon": "👥", "enabled": true, "parentKey": null, "prompt": "整理受访者、话题、主要故事与可直接引用的原话，分清原话与概述。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "course_learning", "kind": "template", "title": "课程学习", "description": "抓重点、学方法", "icon": "👩🏻‍🎓", "enabled": true, "parentKey": null, "prompt": "整理课程主题、核心概念、例子、可复用的方法和原文提出的问题。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"},
    {"itemKey": "oral_creation", "kind": "template", "title": "口述创作", "description": "把口述理成稿", "icon": "🎤", "enabled": true, "parentKey": null, "prompt": "梳理口述的中心观点及说理顺序，保留可复用的素材、例子和关键表达。 输出清晰的 Markdown 纲要，保持原文语言，保留可核对的事实，省略原文未提供的信息。"}
  ]
}
$catalog$::jsonb),
    ('editor_polish', $catalog$
{
  "title": "AI 润色", "displayLimit": 5,
  "items": [
    {"itemKey": "relation_shift", "kind": "group", "title": "社会关系转变", "description": "", "icon": "", "enabled": true, "displayLimit": 5},
    {"itemKey": "deepen_needs", "kind": "template", "title": "需求深化", "description": "", "icon": "", "enabled": true, "parentKey": null, "prompt": "围绕原文的受众和需求，将表述具体化，补足原文能够支持的动机、痛点和使用场景。保持原文事实，直接输出改写后的正文。"},
    {"itemKey": "strengthen_differentiation", "kind": "template", "title": "差异化增强", "description": "", "icon": "", "enabled": true, "parentKey": null, "prompt": "突出原文已有的独特点、相对优势和个人表达，减少空泛套话。依据原文事实，直接输出改写后的正文。"},
    {"itemKey": "improve_opening", "kind": "template", "title": "开头优化", "description": "", "icon": "", "enabled": true, "parentKey": null, "prompt": "改写开头，让读者快速理解主题和价值，保持后文及原意，直接输出改写后的全文。"},
    {"itemKey": "expand", "kind": "template", "title": "扩写", "description": "", "icon": "", "enabled": true, "parentKey": null, "prompt": "在保留原意、语言和语气的基础上，把简略段落扩展为具体、连贯的正文。只补充有原文依据的细节或清楚标注的一般性例子。直接输出扩写后的正文。"},
    {"itemKey": "relation_peer", "kind": "template", "title": "平等交流", "description": "", "icon": "", "enabled": true, "parentKey": "relation_shift", "prompt": "以平等、尊重的口吻和对方交流，用自然的建议表达。直接输出改写后的正文。"},
    {"itemKey": "relation_friend", "kind": "template", "title": "朋友分享", "description": "", "icon": "", "enabled": true, "parentKey": "relation_shift", "prompt": "用朋友间分享经验的亲切、自然语气，保留信息和原意。直接输出改写后的正文。"},
    {"itemKey": "relation_advisor", "kind": "template", "title": "顾问建议", "description": "", "icon": "", "enabled": true, "parentKey": "relation_shift", "prompt": "用顾问的清晰、审慎语气给出基于原文的判断、理由和可执行建议。直接输出改写后的正文。"},
    {"itemKey": "relation_mentor", "kind": "template", "title": "导师引导", "description": "", "icon": "", "enabled": true, "parentKey": "relation_shift", "prompt": "用循序渐进的导师语气说明方法、提出引导性问题，保留原文观点。直接输出改写后的正文。"},
    {"itemKey": "relation_customer", "kind": "template", "title": "客户对话", "description": "", "icon": "", "enabled": true, "parentKey": "relation_shift", "prompt": "以面向客户的专业语气组织表达，突出对方需要知道的信息和清晰下一步。直接输出改写后的正文。"}
  ]
}
$catalog$::jsonb)
  RETURNING scene_key, draft
)
INSERT INTO public.ai_template_versions(scene_key, revision, catalog)
SELECT scene_key, 1, draft FROM inserted;
