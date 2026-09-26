import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  jwtSecret: process.env.JWT_SECRET ?? "development-only-secret-change-me",
  nodeEnv: process.env.NODE_ENV ?? "development",
};

if (config.nodeEnv === "production" && config.jwtSecret === "development-only-secret-change-me") {
  throw new Error("JWT_SECRET must be set in production");
}