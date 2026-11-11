#!/usr/bin/env node
// npm run privacy [-- --tree] [--staged] [--diff <base>] [--history] [--repo <dir>] [--require-words]
// npm run privacy:hash [-- --in <file>]
import { run } from "./run.ts";

process.exit(run(process.argv.slice(2), process.env, (line) => console.log(line)));
