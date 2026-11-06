/** Payments reduce the ledger balance, so their accounting minus sign still represents money received. */
export function amountTone(value: string | undefined, kind?: string) {
  const amount = BigInt(value || "0");
  if (amount === 0n) return "";
  if (kind === "payment") return "money-payment";
  if (kind === "charge") return "money-charge";
  return amount < 0n ? "money-negative" : "";
}
