type ScheduledInstalment = { due_date: string; amount_minor: string; paid?: boolean };
export type InstalmentPaymentStatus = 'Paid' | 'Settled' | 'Overdue' | 'Due';

/** Reserve explicit payments first, then apply other booking payments by due date. */
export function bookingInstalmentBalances<T extends ScheduledInstalment>(
  instalments: readonly T[], totalMinor: string, paidMinor: string, today: string,
): (T & { remaining_minor: string; payment_status: InstalmentPaymentStatus })[] {
  const total = BigInt(totalMinor), paid = BigInt(paidMinor);
  const assigned = instalments.reduce((sum, row) => sum + (row.paid ? BigInt(row.amount_minor) : 0n), 0n);
  let unassigned = paid > assigned ? paid - assigned : 0n;
  let outstanding = total > paid ? total - paid : 0n;
  const remaining = instalments.map(() => 0n);
  const ordered = instalments.map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.due_date.localeCompare(b.row.due_date) || a.index - b.index);

  for (const { row, index } of ordered) {
    if (row.paid) continue;
    const amount = BigInt(row.amount_minor);
    const covered = unassigned < amount ? unassigned : amount;
    unassigned -= covered;
    const unpaid = amount - covered;
    // Schedule rounding must never create debt beyond the booking balance.
    remaining[index] = unpaid < outstanding ? unpaid : outstanding;
    outstanding -= remaining[index];
  }

  return instalments.map((row, index) => ({
    ...row,
    remaining_minor: remaining[index].toString(),
    payment_status: row.paid ? 'Paid' : remaining[index] === 0n ? 'Settled' : row.due_date < today ? 'Overdue' : 'Due',
  }));
}
