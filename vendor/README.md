# Private Huddle SDK archives

Pronto installs both packages from these real archives. No sibling checkout, source symlink, private registry or separately deployed Huddle product service is needed.

| Archive | Version/source revision | SHA-256 |
| --- | --- | --- |
| huddle-browser-0.2.0.tgz | 0.2.0 / Huddle e645e7f68f7572c3f59ba9c9efe278e510437b01 | 7076e67f7d04183c0b00f71ab791da26df81c9d3e64dba7b4469c04ade3ed4c1 |
| huddle-host-0.2.0.tgz | 0.2.0 / Huddle 00426a5d97976d4ffbcec1309ccc2eceebe5170f | 34f682df574c3541ad51a8814b31cbb7505de2738881ae98e17ad9070cccd0fe |

The browser includes NOTICE and the self-contained integration/contracts/schema guides. Framework peers are optional; Pronto imports only the React and HTTP helpers. The server-only host package uses Pronto's existing PostgreSQL pool and current-user policy. Neither archive contains credentials, feedback, a Huddle account database or a deployed product service. Zod 4.6.7 is the host package's separate dependency; existing Pronto dependency versions are retained.

The unused 0.1.0 archive remains temporarily for the secured legacy integration's recorded history while actual migration/rollback gates are pending. It is absent from current production dependencies and lockfile resolution. Its original source was 2929decd77d666d0732c032d77b7485b390a923b, SHA-256 f89790e94cd256385aceab426a9c585517d52e12a28ad73cefcedb2ecbf86132. Do not switch back to the older data store after new discussion exists.

To refresh, build the verified Huddle revision on Node 24.21.0 / pnpm 10.33.0, pack both packages to an explicit archive destination, copy them here and update the local-file dependencies/lockfile. When replacing a private snapshot with the same package version, force the local archive reinstall and verify installed JavaScript against the archive. Record new checksums/revisions, then run the frozen install, application release checks and dedicated disposable Huddle gates. An old development cache does not establish acceptance of a replacement archive.


These exact archives predate the public-review documentation revision. The authorization callback already supports the host-selected public policy, verified by Pronto’s genuine chooser-session browser tests. Follow [Pronto’s current integration guide](../docs/integrations/huddle.md) for the selected public/private policy and the current Huddle repository guides for open-review setup; the older archive examples do not require Pronto to remain internal-only. The archive bytes, manifest versions and frozen integrity pins are unchanged by the operational CLI retirement.
