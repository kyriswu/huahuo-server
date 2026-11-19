CREATE TABLE public.kb_lexical_terms (
    term_key text COLLATE "C" PRIMARY KEY CHECK (term_key ~ '^[0-9a-f]{64}$'),
    token_id bigint GENERATED ALWAYS AS IDENTITY (MAXVALUE 4294967294) UNIQUE
);

COMMENT ON TABLE public.kb_lexical_terms IS 'Stable sparse vector coordinates for hashed analyzer terms. Coordinates must never be reassigned.';
GRANT SELECT ON public.kb_lexical_terms TO huahuo_api;
GRANT SELECT, INSERT ON public.kb_lexical_terms TO huahuo_worker;
GRANT USAGE ON SEQUENCE public.kb_lexical_terms_token_id_seq TO huahuo_worker;
