INSERT INTO "hello" ("id", "message") VALUES (1, 'Hello from Postgres') ON CONFLICT ("id") DO NOTHING;
