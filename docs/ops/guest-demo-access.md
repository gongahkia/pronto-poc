# Reviewer access to the hosted demo (public POC)

This is a public proof of concept on synthetic data, so reviewers do not need an account. There is no setting to turn it on: it is available on any demo deployment (the same `PRONTO_CUSTOMER_DEMO_ENABLED=1` / protected-demo profile the demo already requires) and never on an ordinary deployment, where `/enter` returns 404.

## What a visitor sees
Opening the home URL sends visitors straight to **/demo**, which offers **Guest / customer** and **Client / business**. A name is optional for feedback attribution; leaving it blank uses "Demo reviewer". Selecting a view submits a same-origin POST that creates the existing 7-day demo-tenant session (`guest-<uuid>@guest.invalid`, no password) and opens customer chat or the business inbox. Viewing the chooser alone creates no user. Returning reviewers reuse their session and see ordinary navigation links, so switching views preserves conversation history. Both screens have **Switch demo view** links. Choosing a view does not change the account role or capabilities. **Reset demo session** signs out and returns to the chooser. Legacy `/enter` and `/login` links redirect to the chooser on enabled demos. Normal non-demo deployments retain account sign-in.

## What they can do
Everything a business user can do in the PS Cafe demo: use the customer chat, work the Inbox (respond, take over, release), approve knowledge, activate channels, manage permissions and escalation policy, and leave, reply to, resolve and export feedback. Every guest and every named bootstrap account holds all six staff capabilities. Operator routes stay operator-only.

## Know before sharing the URL
- Anyone with the URL can change the demo data and see everyone's changes and comments. Reset or re-bootstrap the database if it gets messy.
- Customer chat uses the provider's quota (Groq Free is shared by all visitors). When it runs out, chat stops until it resets.
- Real delivery is still impossible: the deployment's synthetic-only delivery flags apply regardless of who is signed in.
- Guest creation is limited to 8 per visitor and 60 in total per 15 minutes in production (or with `PRONTO_LOGIN_THROTTLE=1`), and to 500 guest users. Remove them with `delete from users where email like '%@guest.invalid'` (their feedback stays, author link cleared).
- To take the demo offline, stop or suspend the service.
