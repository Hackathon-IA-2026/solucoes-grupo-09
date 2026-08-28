import { Elysia } from "elysia";
import { database } from "./connection.js";

/**
 * Decorates the database handle onto the Elysia context so routes can reach
 * persistence via DI. It is `undefined` when no database is configured —
 * handlers should treat that as "persistence disabled".
 */
export const databasePlugin = new Elysia({ name: "database" }).decorate("db", database);
