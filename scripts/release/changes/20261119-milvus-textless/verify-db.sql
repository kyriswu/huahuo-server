SELECT 'lexical_dictionary_table' AS check_name,
       to_regclass('public.kb_lexical_terms') IS NOT NULL AS ok
UNION ALL
SELECT 'lexical_dictionary_role_permissions',
       has_table_privilege('huahuo_api','public.kb_lexical_terms','SELECT')
       AND NOT has_table_privilege('huahuo_api','public.kb_lexical_terms','INSERT')
       AND has_table_privilege('huahuo_worker','public.kb_lexical_terms','SELECT')
       AND has_table_privilege('huahuo_worker','public.kb_lexical_terms','INSERT')
       AND NOT has_table_privilege('huahuo_worker','public.kb_lexical_terms','UPDATE')
       AND NOT has_table_privilege('huahuo_worker','public.kb_lexical_terms','DELETE')
       AND has_sequence_privilege('huahuo_worker','public.kb_lexical_terms_token_id_seq','USAGE')
UNION ALL
SELECT 'lexical_dictionary_unique_index',
       (SELECT count(*) FROM pg_index WHERE indrelid='public.kb_lexical_terms'::regclass
        AND indisunique AND indisvalid) = 2
