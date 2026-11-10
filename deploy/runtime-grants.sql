-- Run as the migration owner after each deployment:
-- psql -v app_schema=public -v app_role=ledgerbook_app -f deploy/runtime-grants.sql
-- Provision the login role separately with a private credential. It must not own the schema.
\set ON_ERROR_STOP on
BEGIN;
SELECT format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),:'app_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA %I TO %I',:'app_schema',:'app_role') \gexec
SELECT format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE %I.%I TO %I',n.nspname,c.relname,:'app_role')
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=:'app_schema' AND c.relkind IN ('r','p') AND c.relname NOT IN ('account_purge_context','schema_migrations') \gexec
SELECT format('GRANT USAGE,SELECT ON SEQUENCE %I.%I TO %I',n.nspname,c.relname,:'app_role')
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=:'app_schema' AND c.relkind='S' \gexec
SELECT format('GRANT SELECT ON TABLE %I.schema_migrations TO %I',:'app_schema',:'app_role') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %I.permanently_delete_customer(uuid,uuid,uuid,text) TO %I',:'app_schema',:'app_role') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %I.permanently_delete_administrator(uuid,uuid,uuid,text) TO %I',:'app_schema',:'app_role') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %I.permanently_delete_workspace(uuid,uuid,text,integer,text) TO %I',:'app_schema',:'app_role') \gexec
SELECT format('REVOKE ALL ON TABLE %I.account_purge_context FROM %I',:'app_schema',:'app_role') \gexec
SELECT format('REVOKE ALL ON FUNCTION %I.account_purge_allows(text,text,jsonb,jsonb) FROM %I',:'app_schema',:'app_role') \gexec
COMMIT;
