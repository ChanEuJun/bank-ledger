import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export * from "./schema";

let pool: pg.Pool | undefined;

/** Lazy so that importing this module (e.g. during `next build`) never touches the database. */
export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  pool ??= new pg.Pool({ connectionString: url });
  return drizzle(pool, { schema });
}
