# Simulated DM retirement

On 20 November 2026 the user requested removal of simulated DMs from the database and frontend, keeping real messaging conversations going forward.

The verified shared-demo database contained 28 console conversations with 101 messages, and one Instagram conversation with four messages. A scoped transaction removed the console conversations and their dependent test records, disabled console channels, and invalidated generated Insights snapshots. It detached 51 model-usage entries from the deleted chats, retaining the accounting for inference actually consumed. Real conversation/message/delivery records, active external-channel configuration and self-serve business settings/sources/rules were checked by digest before and after. They did not change. Existing readonly Huddle data was outside this operation.

An owner-authorized cleanup audit record and private backups/results are retained in ignored `output/instagram-public/simulated-dm-{local,hosted}-{backup,result}.json`. The same operation was verified against the separate local preview database before the hosted transaction. These backups are not committed or served by the app.

`PRONTO_CUSTOMER_SIMULATOR_ENABLED=0` retires the simulator independently of the protected business workspace. Its page/API and direct application session functions reject access; entry offers only the business workspace. Request processing continues for the scoped Instagram account and skips the console transport. Conversations excludes console records regardless of browser filters and does not expose old console deep links.

Do not run fixture/reset/setup commands on hosted data. Disposable offline regressions can opt in to simulation; they are separate from real-channel acceptance. Future customer-flow acceptance must use the connected messaging account. Native owner-reply resumption still needs an actual native-channel acceptance check.
