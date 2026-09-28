import { Router, type IRouter, type Request, type Response } from "express";
import { randomInt } from "node:crypto";
import { and, eq, ilike, sql } from "drizzle-orm";
import { pool } from "@workspace/db";
import {
  CreateAdjustmentBody,
  CreateCategoryBody,
  CreateDeliveryBody,
  CreateLocationBody,
  CreateProductBody,
  CreateReceiptBody,
  CreateTransferBody,
  CreateWarehouseBody,
  ForgotPasswordBody,
  ListLedgerQueryParams,
  ListProductsQueryParams,
  ListStockQueryParams,
  LoginBody,
  ResetPasswordBody,
  SignUpBody,
  UpdateProductBody,
} from "@workspace/api-zod";
import { categoriesTable, productsTable, warehousesTable } from "@workspace/db";
import { createToken, hashPassword, requireAuth, verifyPassword } from "../lib/auth";

const router: IRouter = Router();

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } } }, value: unknown, res: Response) {
  const result = schema.safeParse(value);
  if (!result.success) {
    res.status(400).json({ error: result.error.message });
    return null;
  }
  return result.data;
}

function ref(prefix: string) {
  return `${prefix}-${Date.now()}-${randomInt(1000, 9999)}`;
}

function userView(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

router.post("/auth/signup", async (req, res): Promise<void> => {
  const body = parse(SignUpBody, req.body, res);
  if (!body) return;
  const email = body.email.toLowerCase();
  const existing = await pool.query("select id from users where email = $1", [email]);
  if (existing.rowCount) {
    res.status(409).json({ error: "Email is already registered" });
    return;
  }
  const result = await pool.query(
    "insert into users (name, email, password_hash, role) values ($1, $2, $3, 'MANAGER') returning id, name, email, role",
    [body.name, email, hashPassword(body.password)],
  );
  const user = result.rows[0];
  res.status(201).json({ token: createToken({ id: user.id, role: user.role }), user: userView(user) });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const body = parse(LoginBody, req.body, res);
  if (!body) return;
  const result = await pool.query("select id, name, email, role, password_hash from users where email = $1", [body.email.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  res.json({ token: createToken({ id: user.id, role: user.role }), user: userView(user) });
});

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const body = parse(ForgotPasswordBody, req.body, res);
  if (!body) return;
  const result = await pool.query("select id from users where email = $1", [body.email.toLowerCase()]);
  if (!result.rowCount) {
    res.json({ message: "If the account exists, an OTP has been generated." });
    return;
  }
  const otp = String(randomInt(100000, 1000000));
  await pool.query("update users set reset_otp_hash = $1, reset_otp_expires_at = now() + interval '10 minutes' where id = $2", [hashPassword(otp), result.rows[0].id]);
  req.log.info({ email: body.email, devOtp: otp }, "Password reset OTP generated");
  res.json({ message: "If the account exists, an OTP has been generated.", devOtp: process.env.NODE_ENV === "production" ? undefined : otp });
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const body = parse(ResetPasswordBody, req.body, res);
  if (!body) return;
  const result = await pool.query("select id, reset_otp_hash, reset_otp_expires_at from users where email = $1", [body.email.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !user.reset_otp_hash || !user.reset_otp_expires_at || new Date(user.reset_otp_expires_at) < new Date() || !verifyPassword(body.otp, user.reset_otp_hash)) {
    res.status(400).json({ error: "Invalid or expired OTP" });
    return;
  }
  await pool.query("update users set password_hash = $1, reset_otp_hash = null, reset_otp_expires_at = null where id = $2", [hashPassword(body.newPassword), user.id]);
  res.json({ message: "Password reset successfully" });
});

router.get("/me", requireAuth, async (req, res): Promise<void> => {
  const result = await pool.query("select id, name, email, role from users where id = $1", [req.user!.id]);
  if (!result.rowCount) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user: userView(result.rows[0]) });
});

router.get("/categories", requireAuth, async (_req, res): Promise<void> => {
  const result = await pool.query("select id, name from categories order by name");
  res.json(result.rows);
});

router.post("/categories", requireAuth, async (req, res): Promise<void> => {
  const body = parse(CreateCategoryBody, req.body, res);
  if (!body) return;
  const result = await pool.query("insert into categories (name) values ($1) returning id, name", [body.name]);
  res.status(201).json(result.rows[0]);
});

router.get("/products", requireAuth, async (req, res): Promise<void> => {
  const query = parse(ListProductsQueryParams, req.query, res);
  if (!query) return;
  const values: unknown[] = [];
  const where: string[] = [];
  if (query.search) {
    values.push(`%${query.search}%`);
    where.push(`(p.name ilike $${values.length} or p.sku ilike $${values.length})`);
  }
  if (query.categoryId) {
    values.push(query.categoryId);
    where.push(`p.category_id = $${values.length}`);
  }
  const result = await pool.query(`
    select p.id, p.name, p.sku, p.unit_of_measure as "unitOfMeasure", p.reorder_point as "reorderPoint",
           c.id as category_id, c.name as category_name,
           coalesce(json_agg(json_build_object('id', sb.id, 'productId', sb.product_id, 'locationId', sb.location_id, 'quantity', sb.quantity, 'location', json_build_object('id', l.id, 'name', l.name, 'code', l.code, 'warehouse', json_build_object('id', w.id, 'name', w.name, 'code', w.code)))) filter (where sb.id is not null), '[]') as stock_balances
    from products p
    left join categories c on c.id = p.category_id
    left join stock_balances sb on sb.product_id = p.id
    left join locations l on l.id = sb.location_id
    left join warehouses w on w.id = l.warehouse_id
    ${where.length ? `where ${where.join(" and ")}` : ""}
    group by p.id, c.id
    order by p.name`, values);
  res.json(result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    sku: row.sku,
    unitOfMeasure: row.unitOfMeasure,
    reorderPoint: Number(row.reorderPoint),
    category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
    stockBalances: row.stock_balances,
  })));
});

router.post("/products", requireAuth, async (req, res): Promise<void> => {
  const body = parse(CreateProductBody, req.body, res);
  if (!body) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query(
      "insert into products (name, sku, unit_of_measure, reorder_point, category_id) values ($1, $2, $3, $4, $5) returning id, name, sku, unit_of_measure as \"unitOfMeasure\", reorder_point as \"reorderPoint\", category_id",
      [body.name, body.sku, body.unitOfMeasure, body.reorderPoint ?? 0, body.categoryId ?? null],
    );
    const product = result.rows[0];
    if (body.initialStock) {
      await writeStock(client, product.id, body.initialStock.locationId, body.initialStock.quantity, req.user!.id, "ADJUSTMENT", `INITIAL-${product.id}`, "Initial stock");
    }
    await client.query("commit");
    res.status(201).json({ ...product, reorderPoint: Number(product.reorderPoint), category: null, stockBalances: [] });
  } catch (error) {
    await client.query("rollback");
    req.log.error({ error }, "Failed to create product");
    res.status(400).json({ error: "Could not create product" });
  } finally {
    client.release();
  }
});

router.patch("/products/:id", requireAuth, async (req, res): Promise<void> => {
  const body = parse(UpdateProductBody, req.body, res);
  if (!body) return;
  const result = await pool.query(
    "update products set name = coalesce($1, name), category_id = coalesce($2, category_id), unit_of_measure = coalesce($3, unit_of_measure), reorder_point = coalesce($4, reorder_point), updated_at = now() where id = $5 returning id, name, sku, unit_of_measure as \"unitOfMeasure\", reorder_point as \"reorderPoint\", category_id",
    [body.name ?? null, body.categoryId ?? null, body.unitOfMeasure ?? null, body.reorderPoint ?? null, req.params.id],
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  res.json({ ...result.rows[0], reorderPoint: Number(result.rows[0].reorderPoint), category: null, stockBalances: [] });
});

router.get("/warehouses", requireAuth, async (_req, res): Promise<void> => {
  const result = await pool.query(`
    select w.id, w.name, w.code, w.address,
      coalesce(json_agg(json_build_object('id', l.id, 'name', l.name, 'code', l.code, 'warehouseId', l.warehouse_id)) filter (where l.id is not null), '[]') as locations
    from warehouses w left join locations l on l.warehouse_id = w.id
    group by w.id order by w.name`);
  res.json(result.rows);
});

router.post("/warehouses", requireAuth, async (req, res): Promise<void> => {
  const body = parse(CreateWarehouseBody, req.body, res);
  if (!body) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const created = await client.query("insert into warehouses (name, code, address) values ($1, $2, $3) returning id, name, code, address", [body.name, body.code, body.address ?? null]);
    const locations = [];
    for (const location of body.locations) {
      const result = await client.query("insert into locations (name, code, warehouse_id) values ($1, $2, $3) returning id, name, code, warehouse_id as \"warehouseId\"", [location.name, location.code, created.rows[0].id]);
      locations.push(result.rows[0]);
    }
    await client.query("commit");
    res.status(201).json({ ...created.rows[0], locations });
  } catch {
    await client.query("rollback");
    res.status(400).json({ error: "Could not create warehouse" });
  } finally {
    client.release();
  }
});

router.post("/warehouses/:id/locations", requireAuth, async (req, res): Promise<void> => {
  const body = parse(CreateLocationBody, req.body, res);
  if (!body) return;
  const result = await pool.query("insert into locations (name, code, warehouse_id) values ($1, $2, $3) returning id, name, code, warehouse_id as \"warehouseId\"", [body.name, body.code, req.params.id]);
  res.status(201).json(result.rows[0]);
});

router.get("/stock", requireAuth, async (req, res): Promise<void> => {
  const query = parse(ListStockQueryParams, req.query, res);
  if (!query) return;
  const values: unknown[] = [];
  const conditions = [];
  if (query.productId) { values.push(query.productId); conditions.push(`sb.product_id = $${values.length}`); }
  if (query.locationId) { values.push(query.locationId); conditions.push(`sb.location_id = $${values.length}`); }
  const result = await pool.query(`
    select sb.id, sb.product_id as "productId", sb.location_id as "locationId", sb.quantity,
      json_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unitOfMeasure', p.unit_of_measure, 'reorderPoint', p.reorder_point) as product,
      json_build_object('id', l.id, 'name', l.name, 'code', l.code, 'warehouse', json_build_object('id', w.id, 'name', w.name, 'code', w.code)) as location
    from stock_balances sb join products p on p.id = sb.product_id join locations l on l.id = sb.location_id join warehouses w on w.id = l.warehouse_id
    ${conditions.length ? `where ${conditions.join(" and ")}` : ""} order by p.name`, values);
  res.json(result.rows.map((row) => ({ ...row, quantity: Number(row.quantity), product: { ...row.product, reorderPoint: Number(row.product.reorderPoint) } })));
});

router.get("/ledger", requireAuth, async (req, res): Promise<void> => {
  const query = parse(ListLedgerQueryParams, req.query, res);
  if (!query) return;
  const values: unknown[] = [];
  const conditions = [];
  for (const [key, column] of [["productId", "le.product_id"], ["locationId", "le.location_id"], ["referenceType", "le.reference_type"]] as const) {
    const value = query[key];
    if (value) { values.push(value); conditions.push(`${column} = $${values.length}`); }
  }
  values.push(query.limit ?? 100);
  const result = await pool.query(`
    select le.id, le.product_id as "productId", le.location_id as "locationId", le.quantity_delta as "quantityDelta", le.quantity_before as "quantityBefore", le.quantity_after as "quantityAfter", le.reason, le.reference_type as "referenceType", le.reference_id as "referenceId", le.note, le.created_at as "createdAt",
      json_build_object('id', p.id, 'name', p.name, 'sku', p.sku, 'unitOfMeasure', p.unit_of_measure, 'reorderPoint', p.reorder_point) as product,
      json_build_object('id', l.id, 'name', l.name, 'code', l.code, 'warehouse', json_build_object('id', w.id, 'name', w.name, 'code', w.code)) as location
    from stock_ledger le join products p on p.id = le.product_id join locations l on l.id = le.location_id join warehouses w on w.id = l.warehouse_id
    ${conditions.length ? `where ${conditions.join(" and ")}` : ""} order by le.created_at desc limit $${values.length}`, values);
  res.json(result.rows.map((row) => ({ ...row, quantityDelta: Number(row.quantityDelta), quantityBefore: Number(row.quantityBefore), quantityAfter: Number(row.quantityAfter), product: { ...row.product, reorderPoint: Number(row.product.reorderPoint) } })));
});

router.get("/dashboard", requireAuth, async (req, res): Promise<void> => {
  const result = await pool.query(`
    with totals as (
      select p.id, sum(coalesce(sb.quantity, 0)) as total, max(p.reorder_point) as reorder_point
      from products p left join stock_balances sb on sb.product_id = p.id group by p.id
    )
    select
      (select count(*) from totals where total > 0)::int as "totalProductsInStock",
      coalesce((select sum(total) from totals), 0)::float as "totalUnits",
      (select count(*) from totals where total > 0 and total <= reorder_point)::int as "lowStockItems",
      (select count(*) from totals where total <= 0)::int as "outOfStockItems",
      (select count(*) from receipts where status <> 'DONE')::int as "pendingReceipts",
      (select count(*) from deliveries where status <> 'DONE')::int as "pendingDeliveries",
      (select count(*) from internal_transfers where status <> 'DONE')::int as "scheduledTransfers"`);
  res.json(result.rows[0]);
});

async function writeStock(client: { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> }, productId: string, locationId: string, delta: number, userId: string, type: "RECEIPT" | "DELIVERY" | "INTERNAL_TRANSFER" | "ADJUSTMENT", referenceId: string, note: string) {
  const current = await client.query("select quantity from stock_balances where product_id = $1 and location_id = $2 for update", [productId, locationId]);
  const before = Number(current.rows[0]?.quantity ?? 0);
  const after = before + delta;
  if (after < 0) throw new Error("Insufficient stock");
  if (current.rowCount) {
    await client.query("update stock_balances set quantity = $1, updated_at = now() where product_id = $2 and location_id = $3", [after, productId, locationId]);
  } else {
    await client.query("insert into stock_balances (product_id, location_id, quantity) values ($1, $2, $3)", [productId, locationId, after]);
  }
  await client.query("insert into stock_ledger (product_id, location_id, quantity_delta, quantity_before, quantity_after, reason, reference_type, reference_id, note, created_by_id) values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)", [productId, locationId, delta, before, after, type, referenceId, note, userId]);
}

async function listOperation(res: Response, table: string, itemsTable: string, locationColumn?: string) {
  const column = locationColumn ?? "";
  const result = await pool.query(`select o.*, coalesce(json_agg(json_build_object('productId', i.product_id, 'quantity', i.quantity)) filter (where i.id is not null), '[]') as items from ${table} o left join ${itemsTable} i on i.${table === "receipts" ? "receipt_id" : table === "deliveries" ? "delivery_id" : table === "internal_transfers" ? "transfer_id" : "adjustment_id"} = o.id group by o.id order by o.created_at desc`);
  res.json(result.rows.map((row) => ({ ...row, [column]: row[column], items: row.items.map((item: { quantity: number }) => ({ ...item, quantity: Number(item.quantity) })) })));
}

router.get("/receipts", requireAuth, async (_req, res) => listOperation(res, "receipts", "receipt_items", "destination_location_id"));
router.get("/deliveries", requireAuth, async (_req, res) => listOperation(res, "deliveries", "delivery_items", "source_location_id"));
router.get("/transfers", requireAuth, async (_req, res) => listOperation(res, "internal_transfers", "internal_transfer_items", "source_location_id"));
router.get("/adjustments", requireAuth, async (_req, res) => listOperation(res, "adjustments", "adjustment_items"));

async function createOperation(req: Request, res: Response, type: "receipt" | "delivery" | "transfer" | "adjustment") {
  const schema = { receipt: CreateReceiptBody, delivery: CreateDeliveryBody, transfer: CreateTransferBody, adjustment: CreateAdjustmentBody }[type];
  const body = parse(schema, req.body, res);
  if (!body) return;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const idResult = await client.query("select gen_random_uuid() as id");
    const id = idResult.rows[0].id;
    let reference = ref(type === "receipt" ? "REC" : type === "delivery" ? "DEL" : type === "transfer" ? "TRF" : "ADJ");
    if (type === "receipt") {
      await client.query("insert into receipts (id, reference, supplier, destination_location_id, created_by_id) values ($1, $2, $3, $4, $5)", [id, reference, (body as any).supplier ?? null, (body as any).destinationLocationId, req.user!.id]);
      for (const item of (body as any).items) await client.query("insert into receipt_items (receipt_id, product_id, location_id, quantity) values ($1, $2, $3, $4)", [id, item.productId, (body as any).destinationLocationId, item.quantity]);
    } else if (type === "delivery") {
      await client.query("insert into deliveries (id, reference, customer, source_location_id, created_by_id) values ($1, $2, $3, $4, $5)", [id, reference, (body as any).customer ?? null, (body as any).sourceLocationId, req.user!.id]);
      for (const item of (body as any).items) await client.query("insert into delivery_items (delivery_id, product_id, quantity) values ($1, $2, $3)", [id, item.productId, item.quantity]);
    } else if (type === "transfer") {
      await client.query("insert into internal_transfers (id, reference, source_location_id, destination_location_id, created_by_id) values ($1, $2, $3, $4, $5)", [id, reference, (body as any).sourceLocationId, (body as any).destinationLocationId, req.user!.id]);
      for (const item of (body as any).items) await client.query("insert into internal_transfer_items (transfer_id, product_id, quantity) values ($1, $2, $3)", [id, item.productId, item.quantity]);
    } else {
      await client.query("insert into adjustments (id, reference, reason, created_by_id) values ($1, $2, $3, $4)", [id, reference, (body as any).reason ?? null, req.user!.id]);
      for (const item of (body as any).items) await client.query("insert into adjustment_items (adjustment_id, product_id, location_id, counted_quantity) values ($1, $2, $3, $4)", [id, item.productId, item.locationId, item.countedQuantity]);
    }
    await client.query("commit");
    res.status(201).json({ id, reference, status: "DRAFT", ...(body as any), items: (body as any).items });
  } catch {
    await client.query("rollback");
    res.status(400).json({ error: "Could not create operation" });
  } finally {
    client.release();
  }
}

router.post("/receipts", requireAuth, (req, res) => void createOperation(req, res, "receipt"));
router.post("/deliveries", requireAuth, (req, res) => void createOperation(req, res, "delivery"));
router.post("/transfers", requireAuth, (req, res) => void createOperation(req, res, "transfer"));
router.post("/adjustments", requireAuth, (req, res) => void createOperation(req, res, "adjustment"));

async function validateOperation(req: Request, res: Response, kind: "receipt" | "delivery" | "transfer" | "adjustment") {
  const table = { receipt: "receipts", delivery: "deliveries", transfer: "internal_transfers", adjustment: "adjustments" }[kind];
  const itemTable = { receipt: "receipt_items", delivery: "delivery_items", transfer: "internal_transfer_items", adjustment: "adjustment_items" }[kind];
  const idColumn = kind === "receipt" ? "receipt_id" : kind === "delivery" ? "delivery_id" : kind === "transfer" ? "transfer_id" : "adjustment_id";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const operation = await client.query(`select * from ${table} where id = $1 for update`, [req.params.id]);
    if (!operation.rowCount) throw new Error("Operation not found");
    if (operation.rows[0].status === "DONE") throw new Error("Operation already validated");
    const items = await client.query(`select * from ${itemTable} where ${idColumn} = $1`, [req.params.id]);
    for (const item of items.rows) {
      if (kind === "receipt") await writeStock(client, item.product_id, item.location_id, Number(item.quantity), req.user!.id, "RECEIPT", req.params.id, operation.rows[0].reference);
      if (kind === "delivery") await writeStock(client, item.product_id, operation.rows[0].source_location_id, -Number(item.quantity), req.user!.id, "DELIVERY", req.params.id, operation.rows[0].reference);
      if (kind === "transfer") {
        await writeStock(client, item.product_id, operation.rows[0].source_location_id, -Number(item.quantity), req.user!.id, "INTERNAL_TRANSFER", req.params.id, operation.rows[0].reference);
        await writeStock(client, item.product_id, operation.rows[0].destination_location_id, Number(item.quantity), req.user!.id, "INTERNAL_TRANSFER", req.params.id, operation.rows[0].reference);
      }
      if (kind === "adjustment") {
        const current = await client.query("select quantity from stock_balances where product_id = $1 and location_id = $2", [item.product_id, item.location_id]);
        await writeStock(client, item.product_id, item.location_id, Number(item.counted_quantity) - Number(current.rows[0]?.quantity ?? 0), req.user!.id, "ADJUSTMENT", req.params.id, operation.rows[0].reason ?? operation.rows[0].reference);
      }
    }
    const updated = await client.query(`update ${table} set status = 'DONE', validated_at = now(), updated_at = now() where id = $1 returning *`, [req.params.id]);
    await client.query("commit");
    res.json({ ...updated.rows[0], status: "DONE", items: items.rows.map((item) => ({ productId: item.product_id, quantity: Number(item.quantity ?? item.counted_quantity) })) });
  } catch (error) {
    await client.query("rollback");
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not validate operation" });
  } finally {
    client.release();
  }
}

router.post("/receipts/:id/validate", requireAuth, (req, res) => void validateOperation(req, res, "receipt"));
router.post("/deliveries/:id/validate", requireAuth, (req, res) => void validateOperation(req, res, "delivery"));
router.post("/transfers/:id/validate", requireAuth, (req, res) => void validateOperation(req, res, "transfer"));
router.post("/adjustments/:id/validate", requireAuth, (req, res) => void validateOperation(req, res, "adjustment"));

export default router;