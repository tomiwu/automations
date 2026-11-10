// Vitest setup file: it runs before each test file. Each SQL test file gets its own empty database,
// so that rows from one file (for example the same fixed id) cannot change the result of another file.
import { afterAll } from "vitest";
import { freshDatabase } from "./fresh-database.js";
import { psql } from "./psql.js";

afterAll(freshDatabase(process.env, psql));
