import { integer, pgTable, text } from "drizzle-orm/pg-core";

/** Hello-world table for the scaffold; replaced by the real schema in a later ticket. */
export const hello = pgTable("hello", {
  id: integer("id").primaryKey(),
  message: text("message").notNull(),
});
