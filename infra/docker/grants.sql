SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO noon_app', schemaname, tablename)
FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations' \gexec
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO noon_app;
