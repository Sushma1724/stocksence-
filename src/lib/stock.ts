import { LedgerReason, OperationType, Prisma } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

export async function changeStock(
  tx: Transaction,
  input: {
    productId: string;
    locationId: string;
    delta: Prisma.Decimal;
    reason: LedgerReason;
    referenceType: OperationType;
    referenceId: string;
    createdById: string;
    note?: string;
  },
) {
  const existing = await tx.stockBalance.findUnique({
    where: { productId_locationId: { productId: input.productId, locationId: input.locationId } },
  });
  const before = existing?.quantity ?? new Prisma.Decimal(0);
  const after = before.add(input.delta);

  if (after.lessThan(0)) {
    throw new Error(`Insufficient stock for product ${input.productId} at location ${input.locationId}`);
  }

  const balance = await tx.stockBalance.upsert({
    where: { productId_locationId: { productId: input.productId, locationId: input.locationId } },
    create: { productId: input.productId, locationId: input.locationId, quantity: after },
    update: { quantity: after },
  });

  await tx.stockLedgerEntry.create({
    data: {
      productId: input.productId,
      locationId: input.locationId,
      quantityDelta: input.delta,
      quantityBefore: before,
      quantityAfter: after,
      reason: input.reason,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note,
      createdById: input.createdById,
    },
  });

  return balance;
}

export function decimal(value: number | string) {
  return new Prisma.Decimal(value);
}

export function reference(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}