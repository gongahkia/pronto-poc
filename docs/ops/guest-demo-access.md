# Reviewer access to the hosted demo (public POC)

This is a public proof of concept on synthetic data, so reviewers do not need an account. There is no setting to turn it on: it is available on any demo deployment (the same `PRONTO_CUSTOMER_DEMO_ENABLED=1` / protected-demo profile the demo already requires) and never on an ordinary deployment, where `/enter` returns 404.

## What a visitor sees
Opening the URL sends them to **/enter**, where they type a name. After continuing, **/demo** offers **Guest / customer** (customer chat) and **Client / business** (business inbox). Both screens have **Switch demo view** links, and returning to the home URL while signed in opens the chooser. Existing valid deep links still return to the requested page after name entry. Choosing a view does not change the account role or capabilities. They get a 7-day session as a new demo-tenant user (`guest-<uuid>@guest.invalid`, no password) and are attributed by that name in feedback. A "Sign in instead" link remains for named accounts.

## What they can do
Everything a business user can do in the PS Cafe demo: use the customer chat, work the Inbox (respond, take over, release), approve knowledge, activate channels, manage permissions and escalation policy, and leave, reply to, resolve and export feedback. Every guest and every named bootstrap account holds all six staff capabilities. Operator routes stay operator-only.

## Know before sharing the URL
- Anyone with the URL can change the demo data and see everyone's changes and comments. Reset or re-bootstrap the database if it gets messy.
- Customer chat uses the provider's quota (Groq Free is shared by all visitors). When it runs out, chat stops until it resets.
- Real delivery is still impossible: the deployment's synthetic-only delivery flags apply regardless of who is signed in.
- Guest creation is limited to 8 per visitor and 60 in total per 15 minutes in production (or with `PRONTO_LOGIN_THROTTLE=1`), and to 500 guest users. Remove them with `delete from users where email like '%@guest.invalid'` (their feedback stays, author link cleared).
- To take the demo offline, stop or suspend the service.
