# Huddle browser snapshot

`huddle-browser-0.1.0.tgz` is the private browser-only package built from the
sibling Huddle repository at commit
`2929decd77d666d0732c032d77b7485b390a923b`.

SHA-256: `f89790e94cd256385aceab426a9c585517d52e12a28ad73cefcedb2ecbf86132`.

The archive includes its original NOTICE. It bundles no Huddle server, database,
framework runtime, credentials or review data. Pronto imports only `/react`.
Keeping the archive here makes frozen installs and the Render Docker build work
without a sibling checkout or a private npm registry.

To refresh it, build Huddle, run
`pnpm --dir packages/browser pack --pack-destination ../../output/packages`,
copy the new archive here, and run
`pnpm add ./vendor/huddle-browser-0.1.0.tgz --force` in Pronto to refresh the lockfile.
Record the new source commit and SHA-256, then run the integration checks.
