import { BadRequestException } from '@nestjs/common';

/** GBP schedules may be rounded by up to £5 in either direction. */
export function validateInstalmentTotal(amount: bigint, instalments: readonly { amount_minor: string }[]) {
  const difference = instalments.reduce((sum, item) => sum + BigInt(item.amount_minor), 0n) - amount;
  if (difference < -500n || difference > 500n) {
    throw new BadRequestException('Instalments must total within £5.00 above or below the instalment calculation total.');
  }
}
