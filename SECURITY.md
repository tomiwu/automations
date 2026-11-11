# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability, a leaked secret or personal data that you found in the repository.

Use the private report form of the repository host: the "Security" tab, then "Report a vulnerability". Give the file, the steps to see the problem and the effect. Do not put a secret value or personal data in the report: give the place only.

You get an answer when a maintainer has read the report. This is a volunteer project and there is no fixed answer time.

## Supported versions

Only the newest commit of the `main` branch gets fixes.

## How the project protects data

- The repository holds no secret values and no personal data. The database holds only the NAMES of secrets. The values stay in the secret store of the platform.
- Credentials in the database are encrypted (`docs/adr/0001-encrypted-credentials-in-supabase.md`).
- CI runs gitleaks and the privacy check (`tools/privacy-check`) on each change.
- If you run your own deployment, keep your seed file, your `.env` and your private word list out of git. The `.gitignore` has entries for them.
