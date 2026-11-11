# Examples

All data in `examples/` is invented. The Family, the Children, the schools and other places, the Accounts, the Recipients and the Fees are fictional. No row describes a real person, a real school or a real account.

## Rule: only documented example values

Use only the documented example values in this directory. `tools/privacy-check/README.md` has the list of the allowed example values.

- Names: `Example Family`, `Child One`, `Child Two`, `Example School`, and other names that start with `Example`.
- Telegram chat IDs: `1000000` to `1000999`.
- Addresses: `example.com`, `example.org`, `example.net`, or a host that ends in `.example`, `.test` or `.invalid`.
- Secrets: generic secret NAMES only, never a value.
- Account number: the public example number of the tests, which is in `privacy/allowlist.json`.

`npm run privacy -- --tree` checks every tracked file, and thus every file in `examples/`. A test in `tools/privacy-check` fails if a file in `examples/` is out of the scope of the check or has a finding.

## The seed file

`seed.example.json` is a seed file with invented data. It shows the format for `admin import-seed`.

- It has one Family, two Children, three Accounts, two Activities and two Recipients.
- The secret NAMES are generic: `CHILD1_LIBRUS_LOGIN`, `CHILD1_LIBRUS_PASSWORD`, `CHILD2_MONDO_LOGIN` and so on. The file never holds a secret value.
- The Recipient `1000001` gets messages in `pl` for both Children. The Recipient `1000002` gets messages in `en` for Child One only.
- The chat IDs and the addresses are fake.

Copy the file to your own computer, change the data, and keep the copy out of the repository.
Enter the secret values in the secret store of your platform under the NAMES that the file uses.
