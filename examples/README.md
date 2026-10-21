# Examples

`seed.example.json` is a seed file with invented data. It shows the format for `admin import-seed`.

- It has one Family, two Children, three Accounts, two Activities and two Recipients.
- The secret NAMES are generic: `CHILD1_LIBRUS_LOGIN`, `CHILD1_LIBRUS_PASSWORD`, `CHILD2_MONDO_LOGIN` and so on. The file never holds a secret value.
- The Recipient `1000001` gets messages in `pl` for both Children. The Recipient `1000002` gets messages in `en` for Child One only.
- The chat IDs and the addresses are fake.

Copy the file to your own computer, change the data, and keep the copy out of the repository.
Enter the secret values in the secret store of your platform under the NAMES that the file uses.
