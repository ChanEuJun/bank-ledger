/** Framework-free ledger logic lives here. Nothing in this package may import Next.js. */
export function greeting(message: string): string {
  return `${message}, from the ledger core`;
}
