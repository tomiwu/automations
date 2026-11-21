export const SKIP_NOTICE = "TEST_DATABASE_URL is not set: the database tests are skipped. Run `npm run test:sql:local` at the root to run them.";

export const skipNotice = (env: Record<string, string | undefined>): string[] => (env.TEST_DATABASE_URL ? [] : [SKIP_NOTICE]);
