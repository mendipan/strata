// Synthetic source for read-only proposal tests; never imported by A1.
export function add(total, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return { accepted: false, total };
  return total + amount <= 6 ? { accepted: true, total: total + amount } : { accepted: false, total };
}
