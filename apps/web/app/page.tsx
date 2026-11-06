import { greeting } from "@ledger/core";
import { getDb, hello } from "@ledger/db";
import { eq } from "drizzle-orm";

// Read at request time: `next build` must never touch the database.
export const dynamic = "force-dynamic";

export default async function Home() {
  const [row] = await getDb().select().from(hello).where(eq(hello.id, 1));
  return (
    <main>
      <h1>Bank ledger</h1>
      <p data-testid="hello">{greeting(row?.message ?? "no row found")}</p>
    </main>
  );
}
