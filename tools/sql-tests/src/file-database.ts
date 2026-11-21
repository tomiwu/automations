import { afterAll } from "vitest";
import { freshDatabase } from "./fresh-database.js";
import { psql } from "./psql.js";

afterAll(freshDatabase(process.env, psql));
