import {
  boolean,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["MANAGER", "STAFF"]);
export const operationStatus = pgEnum("operation_status", [
  "DRAFT",
  "WAITING",
  "READY",
  "DONE",
  "CANCELED",
]);
export const operationType = pgEnum("operation_type", [
  "RECEIPT",
  "DELIVERY",
  "INTERNAL_TRANSFER",
  "ADJUSTMENT",
]);

const id = () => uuid("id").defaultRandom().primaryKey();
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const usersTable = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("STAFF"),
  resetOtpHash: text("reset_otp_hash"),
  resetOtpExpiresAt: timestamp("reset_otp_expires_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("users_email_idx").on(table.email)]);

export const categoriesTable = pgTable("categories", {
  id: id(),
  name: text("name").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [uniqueIndex("categories_name_idx").on(table.name)]);

export const warehousesTable = pgTable("warehouses", {
  id: id(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  address: text("address"),
  createdAt: timestamps.createdAt,
}, (table) => [uniqueIndex("warehouses_code_idx").on(table.code)]);

export const locationsTable = pgTable("locations", {
  id: id(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  warehouseId: uuid("warehouse_id").notNull().references(() => warehousesTable.id, { onDelete: "cascade" }),
  createdAt: timestamps.createdAt,
}, (table) => [uniqueIndex("locations_warehouse_code_idx").on(table.warehouseId, table.code)]);

export const productsTable = pgTable("products", {
  id: id(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  unitOfMeasure: text("unit_of_measure").notNull(),
  reorderPoint: numeric("reorder_point", { precision: 18, scale: 3, mode: "number" }).notNull().default(0),
  categoryId: uuid("category_id").references(() => categoriesTable.id, { onDelete: "set null" }),
  ...timestamps,
}, (table) => [
  uniqueIndex("products_sku_idx").on(table.sku),
]);

export const receiptsTable = pgTable("receipts", {
  id: id(),
  reference: text("reference").notNull(),
  supplier: text("supplier"),
  destinationLocationId: uuid("destination_location_id").notNull().references(() => locationsTable.id),
  status: operationStatus("status").notNull().default("DRAFT"),
  createdById: uuid("created_by_id").notNull().references(() => usersTable.id),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("receipts_reference_idx").on(table.reference)]);

export const receiptItemsTable = pgTable("receipt_items", {
  id: id(),
  receiptId: uuid("receipt_id").notNull().references(() => receiptsTable.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => productsTable.id),
  locationId: uuid("location_id").notNull().references(() => locationsTable.id),
  quantity: numeric("quantity", { precision: 18, scale: 3, mode: "number" }).notNull(),
});

export const deliveriesTable = pgTable("deliveries", {
  id: id(),
  reference: text("reference").notNull(),
  customer: text("customer"),
  sourceLocationId: uuid("source_location_id").notNull().references(() => locationsTable.id),
  status: operationStatus("status").notNull().default("DRAFT"),
  createdById: uuid("created_by_id").notNull().references(() => usersTable.id),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("deliveries_reference_idx").on(table.reference)]);

export const deliveryItemsTable = pgTable("delivery_items", {
  id: id(),
  deliveryId: uuid("delivery_id").notNull().references(() => deliveriesTable.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => productsTable.id),
  quantity: numeric("quantity", { precision: 18, scale: 3, mode: "number" }).notNull(),
});

export const transfersTable = pgTable("internal_transfers", {
  id: id(),
  reference: text("reference").notNull(),
  sourceLocationId: uuid("source_location_id").notNull().references(() => locationsTable.id),
  destinationLocationId: uuid("destination_location_id").notNull().references(() => locationsTable.id),
  status: operationStatus("status").notNull().default("DRAFT"),
  createdById: uuid("created_by_id").notNull().references(() => usersTable.id),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("transfers_reference_idx").on(table.reference)]);

export const transferItemsTable = pgTable("internal_transfer_items", {
  id: id(),
  transferId: uuid("transfer_id").notNull().references(() => transfersTable.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => productsTable.id),
  quantity: numeric("quantity", { precision: 18, scale: 3, mode: "number" }).notNull(),
});

export const adjustmentsTable = pgTable("adjustments", {
  id: id(),
  reference: text("reference").notNull(),
  reason: text("reason"),
  status: operationStatus("status").notNull().default("DRAFT"),
  createdById: uuid("created_by_id").notNull().references(() => usersTable.id),
  validatedAt: timestamp("validated_at", { withTimezone: true }),
  ...timestamps,
}, (table) => [uniqueIndex("adjustments_reference_idx").on(table.reference)]);

export const adjustmentItemsTable = pgTable("adjustment_items", {
  id: id(),
  adjustmentId: uuid("adjustment_id").notNull().references(() => adjustmentsTable.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => productsTable.id),
  locationId: uuid("location_id").notNull().references(() => locationsTable.id),
  countedQuantity: numeric("counted_quantity", { precision: 18, scale: 3, mode: "number" }).notNull(),
});

export const stockBalancesTable = pgTable("stock_balances", {
  id: id(),
  productId: uuid("product_id").notNull().references(() => productsTable.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locationsTable.id, { onDelete: "cascade" }),
  quantity: numeric("quantity", { precision: 18, scale: 3, mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("stock_balances_product_location_idx").on(table.productId, table.locationId)]);

export const ledgerTable = pgTable("stock_ledger", {
  id: id(),
  productId: uuid("product_id").notNull().references(() => productsTable.id),
  locationId: uuid("location_id").notNull().references(() => locationsTable.id),
  quantityDelta: numeric("quantity_delta", { precision: 18, scale: 3, mode: "number" }).notNull(),
  quantityBefore: numeric("quantity_before", { precision: 18, scale: 3, mode: "number" }).notNull(),
  quantityAfter: numeric("quantity_after", { precision: 18, scale: 3, mode: "number" }).notNull(),
  reason: operationType("reason").notNull(),
  referenceType: operationType("reference_type").notNull(),
  referenceId: uuid("reference_id").notNull(),
  note: text("note"),
  createdById: uuid("created_by_id").notNull().references(() => usersTable.id),
  createdAt: timestamps.createdAt,
});

export const demoSeedMarkerTable = pgTable("demo_seed_marker", {
  id: id(),
  seeded: boolean("seeded").notNull().default(false),
});