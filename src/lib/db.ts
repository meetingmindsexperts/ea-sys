import { PrismaClient } from "@prisma/client";
import { dbLogger } from "./logger";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const client = new PrismaClient({
    // Only log errors - remove query logging to keep console clean
    log: [
      {
        emit: "event",
        level: "error",
      },
      {
        emit: "event",
        level: "warn",
      },
    ],
  });

  // Handle Prisma events with our logger
  client.$on("error" as never, (e: { message: string; target?: string }) => {
    dbLogger.error({
      msg: "Prisma error",
      error: e.message,
      target: e.target,
    });
  });

  client.$on("warn" as never, (e: { message: string }) => {
    dbLogger.warn({
      msg: "Prisma warning",
      warning: e.message,
    });
  });

  dbLogger.info("Prisma client initialized");

  return client;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
