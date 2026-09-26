# StockSense API

Backend and database for the StockSense inventory management system.

## Stack

- TypeScript + Fastify
- PostgreSQL + Prisma
- JWT authentication
- Zod request validation

## Local setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and `JWT_SECRET`.
2. Install dependencies: `npm install`
3. Generate the Prisma client: `npm run db:generate`
4. Apply the schema: `npx prisma migrate dev --name init`
5. Optional demo data: `npm run db:seed`
6. Start the API: `npm run dev`

The API is available at `http://localhost:3000`, with a health check at
`GET /health`.

## Core API

All routes under `/api` except authentication require:

```text
Authorization: Bearer <jwt>
```

| Area | Routes |
| --- | --- |
| Auth | `POST /api/auth/signup`, `/login`, `/forgot-password`, `/reset-password` |
| Dashboard | `GET /api/dashboard` |
| Products | `GET/POST /api/products`, `PATCH /api/products/:id` |
| Warehouses | `GET/POST /api/warehouses`, `POST /api/warehouses/:id/locations` |
| Stock | `GET /api/stock`, `GET /api/ledger` |
| Receipts | `GET/POST /api/receipts`, `POST /api/receipts/:id/validate` |
| Deliveries | `GET/POST /api/deliveries`, `POST /api/deliveries/:id/validate` |
| Transfers | `GET/POST /api/transfers`, `POST /api/transfers/:id/validate` |
| Adjustments | `GET/POST /api/adjustments`, `POST /api/adjustments/:id/validate` |

Every validated stock-changing action writes to `stock_ledger` in the same
database transaction as the balance update.