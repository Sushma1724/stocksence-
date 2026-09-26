import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import { LedgerReason, OperationStatus, OperationType, Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { changeStock, decimal, reference } from "./lib/stock.js";

const passwordSchema = z.string().min(8).max(128);
const idParam = z.object({ id: z.string().min(1) });
const quantity = z.coerce.number().positive();

const productInclude = { category: true, stockBalances: { include: { location: { include: { warehouse: true } } } } } as const;
const operationInclude = { items: true };

function publicUser(user: { id: string; name: string; email: string; role: string }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function auth(_app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (!token) throw new Error("Missing bearer token");
      const verified = await jwtVerify(token, jwtKey);
      const payload = verified.payload as { userId?: string; role?: "MANAGER" | "STAFF" };
      if (!payload.userId || !payload.role) throw new Error("Invalid token");
      request.user = { userId: payload.userId, role: payload.role };
    } catch {
      return reply.unauthorized("Authentication required");
    }
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected error";
}

const jwtKey = new TextEncoder().encode(config.jwtSecret);

async function signToken(payload: { userId: string; role: "MANAGER" | "STAFF" }) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(jwtKey);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(sensible);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.badRequest(error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(", "));
    }
    app.log.error(error);
    return reply.internalServerError(config.nodeEnv === "production" ? "Internal server error" : getErrorMessage(error));
  });

  app.get("/health", async () => ({ status: "ok", service: "stocksense-api" }));

  app.post("/api/auth/signup", async (request, reply) => {
    const body = z.object({ name: z.string().min(2).max(100), email: z.string().email(), password: passwordSchema }).parse(request.body);
    const email = body.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.conflict("Email is already registered");
    const user = await prisma.user.create({
      data: { name: body.name, email, passwordHash: await bcrypt.hash(body.password, 12), role: "MANAGER" },
    });
    const token = await signToken({ userId: user.id, role: user.role });
    return reply.code(201).send({ token, user: publicUser(user) });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) return reply.unauthorized("Invalid email or password");
    const token = await signToken({ userId: user.id, role: user.role });
    return { token, user: publicUser(user) };
  });

  app.post("/api/auth/forgot-password", async (request) => {
    const body = z.object({ email: z.string().email() }).parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user) return { message: "If the account exists, an OTP has been generated." };
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await prisma.user.update({
      where: { id: user.id },
      data: { resetOtpHash: await bcrypt.hash(otp, 10), resetOtpExpiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    request.log.info({ email: user.email, otp }, "Password reset OTP generated. Connect an email provider before production use.");
    return { message: "If the account exists, an OTP has been generated.", ...(config.nodeEnv !== "production" ? { devOtp: otp } : {}) };
  });

  app.post("/api/auth/reset-password", async (request, reply) => {
    const body = z.object({ email: z.string().email(), otp: z.string().length(6), newPassword: passwordSchema }).parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!user?.resetOtpHash || !user.resetOtpExpiresAt || user.resetOtpExpiresAt < new Date() || !(await bcrypt.compare(body.otp, user.resetOtpHash))) {
      return reply.badRequest("Invalid or expired OTP");
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(body.newPassword, 12), resetOtpHash: null, resetOtpExpiresAt: null },
    });
    return { message: "Password reset successfully" };
  });

  const requireAuth = auth(app);

  app.get("/api/me", { preHandler: requireAuth }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.userId } });
    if (!user) return reply.notFound("User not found");
    return { user: publicUser(user) };
  });

  app.get("/api/categories", { preHandler: requireAuth }, async () => prisma.category.findMany({ orderBy: { name: "asc" } }));
  app.post("/api/categories", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(100) }).parse(request.body);
    return reply.code(201).send(await prisma.category.create({ data: { name: body.name } }));
  });

  app.get("/api/products", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ search: z.string().optional(), categoryId: z.string().optional() }).parse(request.query);
    return prisma.product.findMany({
      where: {
        categoryId: query.categoryId,
        OR: query.search ? [{ name: { contains: query.search, mode: "insensitive" } }, { sku: { contains: query.search, mode: "insensitive" } }] : undefined,
      },
      include: productInclude,
      orderBy: { name: "asc" },
    });
  });

  app.post("/api/products", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({
      name: z.string().min(1).max(200),
      sku: z.string().min(1).max(80),
      categoryId: z.string().optional(),
      unitOfMeasure: z.string().min(1).max(30),
      reorderPoint: z.coerce.number().min(0).default(0),
      initialStock: z.object({ locationId: z.string(), quantity: quantity }).optional(),
    }).parse(request.body);
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: { name: body.name, sku: body.sku, categoryId: body.categoryId, unitOfMeasure: body.unitOfMeasure, reorderPoint: decimal(body.reorderPoint) },
      });
      if (body.initialStock) {
        await changeStock(tx, { productId: created.id, locationId: body.initialStock.locationId, delta: decimal(body.initialStock.quantity), reason: LedgerReason.ADJUSTMENT, referenceType: OperationType.ADJUSTMENT, referenceId: `INITIAL-${created.id}`, createdById: request.user.userId, note: "Initial stock" });
      }
      return created;
    });
    return reply.code(201).send(product);
  });

  app.patch("/api/products/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParam.parse(request.params);
    const body = z.object({ name: z.string().min(1).max(200).optional(), categoryId: z.string().nullable().optional(), unitOfMeasure: z.string().min(1).max(30).optional(), reorderPoint: z.coerce.number().min(0).optional() }).parse(request.body);
    const product = await prisma.product.update({ where: { id: params.id }, data: { ...body, reorderPoint: body.reorderPoint === undefined ? undefined : decimal(body.reorderPoint) } });
    return reply.send(product);
  });

  app.get("/api/warehouses", { preHandler: requireAuth }, async () => prisma.warehouse.findMany({ include: { locations: true }, orderBy: { name: "asc" } }));
  app.post("/api/warehouses", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ name: z.string().min(1).max(100), code: z.string().min(1).max(30), address: z.string().max(250).optional(), locations: z.array(z.object({ name: z.string().min(1), code: z.string().min(1) })).min(1) }).parse(request.body);
    const warehouse = await prisma.warehouse.create({ data: { name: body.name, code: body.code, address: body.address, locations: { create: body.locations } }, include: { locations: true } });
    return reply.code(201).send(warehouse);
  });
  app.post("/api/warehouses/:id/locations", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParam.parse(request.params);
    const body = z.object({ name: z.string().min(1).max(100), code: z.string().min(1).max(30) }).parse(request.body);
    return reply.code(201).send(await prisma.location.create({ data: { ...body, warehouseId: params.id } }));
  });

  app.get("/api/stock", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ productId: z.string().optional(), locationId: z.string().optional() }).parse(request.query);
    return prisma.stockBalance.findMany({ where: query, include: { product: true, location: { include: { warehouse: true } } }, orderBy: { updatedAt: "desc" } });
  });

  app.get("/api/ledger", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ productId: z.string().optional(), locationId: z.string().optional(), referenceType: z.nativeEnum(OperationType).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    return prisma.stockLedgerEntry.findMany({ where: { productId: query.productId, locationId: query.locationId, referenceType: query.referenceType }, include: { product: true, location: { include: { warehouse: true } }, createdBy: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: query.limit });
  });

  app.get("/api/dashboard", { preHandler: requireAuth }, async (request) => {
    const query = z.object({ warehouseId: z.string().optional(), categoryId: z.string().optional(), status: z.nativeEnum(OperationStatus).optional(), type: z.nativeEnum(OperationType).optional() }).parse(request.query);
    const locationIds = query.warehouseId ? (await prisma.location.findMany({ where: { warehouseId: query.warehouseId }, select: { id: true } })).map((item) => item.id) : undefined;
    const balances = await prisma.stockBalance.findMany({ where: { locationId: locationIds ? { in: locationIds } : undefined, product: { categoryId: query.categoryId } }, include: { product: true } });
    const totalUnits = balances.reduce((sum, balance) => sum + Number(balance.quantity), 0);
    const byProduct = new Map<string, { total: number; reorderPoint: number }>();
    for (const balance of balances) {
      const current = byProduct.get(balance.productId) ?? { total: 0, reorderPoint: Number(balance.product.reorderPoint) };
      current.total += Number(balance.quantity);
      byProduct.set(balance.productId, current);
    }
    const lowStockItems = [...byProduct.values()].filter((item) => item.total > 0 && item.total <= item.reorderPoint).length;
    const outOfStockItems = [...byProduct.values()].filter((item) => item.total <= 0).length;
    const [receipts, deliveries, transfers] = await Promise.all([
      prisma.receipt.count({ where: { status: query.type && query.type !== OperationType.RECEIPT ? undefined : query.status ?? { in: [OperationStatus.DRAFT, OperationStatus.WAITING, OperationStatus.READY] }, destinationLocationId: locationIds ? { in: locationIds } : undefined } }),
      prisma.delivery.count({ where: { status: query.type && query.type !== OperationType.DELIVERY ? undefined : query.status ?? { in: [OperationStatus.DRAFT, OperationStatus.WAITING, OperationStatus.READY] }, sourceLocationId: locationIds ? { in: locationIds } : undefined } }),
      prisma.internalTransfer.count({ where: { status: query.type && query.type !== OperationType.INTERNAL_TRANSFER ? undefined : query.status ?? { in: [OperationStatus.DRAFT, OperationStatus.WAITING, OperationStatus.READY] }, sourceLocationId: locationIds ? { in: locationIds } : undefined } }),
    ]);
    return { totalProductsInStock: byProduct.size, totalUnits, lowStockItems, outOfStockItems, pendingReceipts: receipts, pendingDeliveries: deliveries, scheduledTransfers: transfers };
  });

  app.post("/api/receipts", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ supplier: z.string().max(200).optional(), destinationLocationId: z.string(), items: z.array(z.object({ productId: z.string(), quantity })).min(1) }).parse(request.body);
    const receipt = await prisma.receipt.create({ data: { reference: reference("REC"), supplier: body.supplier, destinationLocationId: body.destinationLocationId, createdById: request.user.userId, items: { create: body.items.map((item) => ({ productId: item.productId, locationId: body.destinationLocationId, quantity: decimal(item.quantity) })) } }, include: operationInclude });
    return reply.code(201).send(receipt);
  });
  app.get("/api/receipts", { preHandler: requireAuth }, async () => prisma.receipt.findMany({ include: { ...operationInclude, destinationLocation: true }, orderBy: { createdAt: "desc" } }));
  app.post("/api/receipts/:id/validate", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParam.parse(request.params);
    try {
      const receipt = await prisma.$transaction(async (tx) => {
        const record = await tx.receipt.findUnique({ where: { id: params.id }, include: { items: true } });
        if (!record) throw new Error("Receipt not found");
        if (record.status === OperationStatus.DONE) throw new Error("Receipt is already validated");
        if (record.status === OperationStatus.CANCELED) throw new Error("Canceled receipts cannot be validated");
        for (const item of record.items) await changeStock(tx, { productId: item.productId, locationId: item.locationId, delta: item.quantity, reason: LedgerReason.RECEIPT, referenceType: OperationType.RECEIPT, referenceId: record.id, createdById: request.user.userId, note: record.reference });
        return tx.receipt.update({ where: { id: record.id }, data: { status: OperationStatus.DONE, validatedAt: new Date() }, include: operationInclude });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return receipt;
    } catch (error) {
      return reply.badRequest(getErrorMessage(error));
    }
  });

  app.post("/api/deliveries", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ customer: z.string().max(200).optional(), sourceLocationId: z.string(), items: z.array(z.object({ productId: z.string(), quantity })).min(1) }).parse(request.body);
    const delivery = await prisma.delivery.create({ data: { reference: reference("DEL"), customer: body.customer, sourceLocationId: body.sourceLocationId, createdById: request.user.userId, items: { create: body.items.map((item) => ({ productId: item.productId, quantity: decimal(item.quantity) })) } }, include: operationInclude });
    return reply.code(201).send(delivery);
  });
  app.get("/api/deliveries", { preHandler: requireAuth }, async () => prisma.delivery.findMany({ include: { ...operationInclude, sourceLocation: true }, orderBy: { createdAt: "desc" } }));
  app.post("/api/deliveries/:id/validate", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParam.parse(request.params);
    try {
      const delivery = await prisma.$transaction(async (tx) => {
        const record = await tx.delivery.findUnique({ where: { id: params.id }, include: { items: true } });
        if (!record) throw new Error("Delivery not found");
        if (record.status === OperationStatus.DONE) throw new Error("Delivery is already validated");
        if (record.status === OperationStatus.CANCELED) throw new Error("Canceled deliveries cannot be validated");
        for (const item of record.items) await changeStock(tx, { productId: item.productId, locationId: record.sourceLocationId, delta: item.quantity.negated(), reason: LedgerReason.DELIVERY, referenceType: OperationType.DELIVERY, referenceId: record.id, createdById: request.user.userId, note: record.reference });
        return tx.delivery.update({ where: { id: record.id }, data: { status: OperationStatus.DONE, validatedAt: new Date() }, include: operationInclude });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return delivery;
    } catch (error) {
      return reply.badRequest(getErrorMessage(error));
    }
  });

  app.post("/api/transfers", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ sourceLocationId: z.string(), destinationLocationId: z.string(), items: z.array(z.object({ productId: z.string(), quantity })).min(1) }).parse(request.body);
    if (body.sourceLocationId === body.destinationLocationId) return reply.badRequest("Source and destination locations must differ");
    const transfer = await prisma.internalTransfer.create({ data: { reference: reference("TRF"), sourceLocationId: body.sourceLocationId, destinationLocationId: body.destinationLocationId, createdById: request.user.userId, items: { create: body.items.map((item) => ({ productId: item.productId, quantity: decimal(item.quantity) })) } }, include: operationInclude });
    return reply.code(201).send(transfer);
  });
  app.get("/api/transfers", { preHandler: requireAuth }, async () => prisma.internalTransfer.findMany({ include: { ...operationInclude, sourceLocation: true, destinationLocation: true }, orderBy: { createdAt: "desc" } }));
  app.post("/api/transfers/:id/validate", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParam.parse(request.params);
    try {
      const transfer = await prisma.$transaction(async (tx) => {
        const record = await tx.internalTransfer.findUnique({ where: { id: params.id }, include: { items: true } });
        if (!record) throw new Error("Transfer not found");
        if (record.status === OperationStatus.DONE) throw new Error("Transfer is already validated");
        if (record.status === OperationStatus.CANCELED) throw new Error("Canceled transfers cannot be validated");
        for (const item of record.items) {
          await changeStock(tx, { productId: item.productId, locationId: record.sourceLocationId, delta: item.quantity.negated(), reason: LedgerReason.INTERNAL_TRANSFER, referenceType: OperationType.INTERNAL_TRANSFER, referenceId: record.id, createdById: request.user.userId, note: record.reference });
          await changeStock(tx, { productId: item.productId, locationId: record.destinationLocationId, delta: item.quantity, reason: LedgerReason.INTERNAL_TRANSFER, referenceType: OperationType.INTERNAL_TRANSFER, referenceId: record.id, createdById: request.user.userId, note: record.reference });
        }
        return tx.internalTransfer.update({ where: { id: record.id }, data: { status: OperationStatus.DONE, validatedAt: new Date() }, include: operationInclude });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return transfer;
    } catch (error) {
      return reply.badRequest(getErrorMessage(error));
    }
  });

  app.post("/api/adjustments", { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ reason: z.string().max(250).optional(), items: z.array(z.object({ productId: z.string(), locationId: z.string(), countedQuantity: z.coerce.number().min(0) })).min(1) }).parse(request.body);
    const adjustment = await prisma.adjustment.create({ data: { reference: reference("ADJ"), reason: body.reason, createdById: request.user.userId, items: { create: body.items.map((item) => ({ productId: item.productId, locationId: item.locationId, countedQuantity: decimal(item.countedQuantity) })) } }, include: operationInclude });
    return reply.code(201).send(adjustment);
  });
  app.get("/api/adjustments", { preHandler: requireAuth }, async () => prisma.adjustment.findMany({ include: { ...operationInclude }, orderBy: { createdAt: "desc" } }));
  app.post("/api/adjustments/:id/validate", { preHandler: requireAuth }, async (request, reply) => {
    const params = idParam.parse(request.params);
    try {
      const adjustment = await prisma.$transaction(async (tx) => {
        const record = await tx.adjustment.findUnique({ where: { id: params.id }, include: { items: true } });
        if (!record) throw new Error("Adjustment not found");
        if (record.status === OperationStatus.DONE) throw new Error("Adjustment is already validated");
        if (record.status === OperationStatus.CANCELED) throw new Error("Canceled adjustments cannot be validated");
        for (const item of record.items) {
          const current = await tx.stockBalance.findUnique({ where: { productId_locationId: { productId: item.productId, locationId: item.locationId } } });
          const delta = item.countedQuantity.sub(current?.quantity ?? decimal(0));
          await changeStock(tx, { productId: item.productId, locationId: item.locationId, delta, reason: LedgerReason.ADJUSTMENT, referenceType: OperationType.ADJUSTMENT, referenceId: record.id, createdById: request.user.userId, note: record.reason ?? record.reference });
        }
        return tx.adjustment.update({ where: { id: record.id }, data: { status: OperationStatus.DONE, validatedAt: new Date() }, include: operationInclude });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return adjustment;
    } catch (error) {
      return reply.badRequest(getErrorMessage(error));
    }
  });

  return app;
}