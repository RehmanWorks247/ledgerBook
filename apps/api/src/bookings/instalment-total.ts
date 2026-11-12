import { BadRequestException } from '@nestjs/common';
import { formatMoney } from '../ledger/money';

/** GBP schedules may be rounded by up to £5 in either direction. */
export function validateInstalmentTotal(amount: bigint, instalments: readonly { amount_minor: string }[],targetLabel='instalment calculation total') {
  const scheduled = instalments.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n);
  const difference = scheduled - amount;
  if (difference < -500n || difference > 500n) {
    const minimum = amount > 500n ? amount - 500n : 0n, maximum = amount + 500n;
    const adjustment = difference < 0n ? minimum - scheduled : scheduled - maximum;
    throw new BadRequestException({
      message: `Instalments must total within £5.00 above or below the ${targetLabel}. Total so far: GBP ${formatMoney(scheduled, 2)}. Required: GBP ${formatMoney(amount, 2)}. Allowed range: GBP ${formatMoney(minimum, 2)}–${formatMoney(maximum, 2)}. ${difference < 0n ? 'Add' : 'Remove'} at least GBP ${formatMoney(adjustment, 2)}.`,
      code: 'INSTALMENT_TOTAL_MISMATCH', required_minor: amount.toString(), scheduled_minor: scheduled.toString(),
      difference_minor: difference.toString(), minimum_minor: minimum.toString(), maximum_minor: maximum.toString(), adjustment_minor: adjustment.toString(),
    });
  }
}
