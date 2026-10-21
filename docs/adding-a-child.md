# Add a Child

Run the commands on your own computer. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` first. Use `node --experimental-strip-types tools/admin/src/cli.ts` as `admin`.

1. Add the Child:
   `admin add-child --family <family-id> --name "Child Three" --has-librus --calendar-id <calendar-id>`
   Leave out `--has-librus` when the Child has no Librus.
   The command prints the ID of the Child.
2. Add one Account for each Service of the Child. Use secret NAMES only:
   `admin add-account --family <family-id> --child <child-id> --service librus --login-secret CHILD3_LIBRUS_LOGIN --password-secret CHILD3_LIBRUS_PASSWORD`
   For `activenow`, `edusky` and `mondo`, add `--origin` and `--group` as in `docs/architecture.md`.
3. Add the Activities of the Child that an Account reports:
   `admin add-activity --family <family-id> --child <child-id> --name "Example Chess Club" --weekday 2 --start 15:00 --end 16:00 --account <account-id> --place "Example School"`
   An Account for `activenow`, `edusky` or `mondo` needs at least one enabled Activity.
4. Let the Recipients see the Child. The Recipient has a list of Child IDs. Add a Recipient with the new Child in `--children`. To change an existing Recipient, edit its `child_ids` in the Supabase table editor.
5. Enter the secret values in Kody under the NAMES that `add-account` printed. Approve them for the host.
6. Run `admin list --family <family-id>` and check the rows.

The first run for the new Child is a silent Baseline. To stop an Account, run `admin disable-account --id <account-id>`.

`examples/seed.example.json` shows the same data as a seed file.
