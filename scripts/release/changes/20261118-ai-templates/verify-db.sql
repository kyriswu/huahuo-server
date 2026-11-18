SELECT 'ai_template_storage' AS check_name,
       to_regclass('public.ai_template_scenes') IS NOT NULL
       AND to_regclass('public.ai_template_versions') IS NOT NULL
       AND to_regclass('public.ai_template_published') IS NOT NULL
       AND to_regclass('public.ai_template_runs') IS NOT NULL AS ok
UNION ALL
SELECT 'ai_template_outline_results_index',
       EXISTS (SELECT 1 FROM pg_index
               WHERE indexrelid=to_regclass('public.ai_template_outline_results_idx') AND indisvalid AND indisready)
UNION ALL
SELECT 'ai_template_api_permissions',
       has_table_privilege('huahuo_api', 'public.ai_template_published', 'SELECT')
       AND has_table_privilege('huahuo_api', 'public.ai_template_runs', 'SELECT')
       AND has_table_privilege('huahuo_api', 'public.ai_template_runs', 'INSERT')
       AND has_table_privilege('huahuo_api', 'public.ai_template_runs', 'UPDATE')
       AND NOT has_table_privilege('huahuo_api', 'public.ai_template_scenes', 'UPDATE')
UNION ALL
SELECT 'ai_template_admin_permissions',
       has_table_privilege('huahuo_admin', 'public.ai_template_scenes', 'SELECT')
       AND has_table_privilege('huahuo_admin', 'public.ai_template_scenes', 'UPDATE')
       AND has_table_privilege('huahuo_admin', 'public.ai_template_versions', 'SELECT')
       AND has_table_privilege('huahuo_admin', 'public.ai_template_versions', 'INSERT');
