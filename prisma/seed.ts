import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const category = await prisma.category.upsert({ where: { name: "General" }, update: {}, create: { name: "General" } });
  const warehouse = await prisma.warehouse.upsert({ where: { code: "MAIN" }, update: {}, create: { name: "Main Warehouse", code: "MAIN" } });
  const location = await prisma.location.upsert({ where: { warehouseId_code: { warehouseId: warehouse.id, code: "RACK-A" } }, update: {}, create: { warehouseId: warehouse.id, name: "Rack A", code: "RACK-A" } });
  await prisma.product.upsert({ where: { sku: "DEMO-001" }, update: {}, create: { name: "Demo Product", sku: "DEMO-001", unitOfMeasure: "units", categoryId: category.id, reorderPoint: 10 } });
  await prisma.user.upsert({ where: { email: "manager@stocksense.local" }, update: {}, create: { name: "Demo Manager", email: "manager@stocksense.local", passwordHash: await bcrypt.hash("ChangeMe123!", 12), role: "MANAGER" } });
  console.log(`Seeded warehouse ${warehouse.name}, location ${location.name}. Demo login: manager@stocksense.local / ChangeMe123!`);
}

main().finally(() => prisma.$disconnect());