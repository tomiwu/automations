/** The line that the SQL tests print when they skip the database tests. */
export const SKIP_NOTICE = "TEST_DATABASE_URL is not set: the database tests are skipped. Run `npm run test:sql:local` at the root to run them.";

/** The lines to print before the tests: the skip notice when there is no test database. */
export const skipNotice = (env: Record<string, string | undefined>): string[] => (env.TEST_DATABASE_URL ? [] : [SKIP_NOTICE]);
