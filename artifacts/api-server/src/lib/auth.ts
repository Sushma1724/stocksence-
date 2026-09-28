import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const secret = process.env.SESSION_SECRET ?? "stocksense-development-secret";

export type AuthUser = { id: string; role: "MANAGER" | "STAFF" };

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function createToken(user: AuthUser) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 }));
  const signature = base64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) return null;
    const expected = base64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
    if (signature !== expected) return null;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as AuthUser & { exp?: number };
    if (!decoded.id || !decoded.role || (decoded.exp ?? 0) < Date.now() / 1000) return null;
    return { id: decoded.id, role: decoded.role };
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  req.user = user;
  next();
}