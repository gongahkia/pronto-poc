# Pronto AI

A restaurant customer-support demo with AI chat, a shared business inbox and
approved business knowledge. The sample outlet is **PS.Cafe Raffles City**.

## Try the hosted demo

Open **https://pronto-ai-poc.onrender.com/enter**, enter your name and continue.
No password is needed. Choose **Guest / customer** to try the chat or
**Client / business** to open the inbox. Use **Switch demo view** to change sides. Anyone with the link can view/change the
shared synthetic demo data. The free host may take about a minute to wake up.

## Run locally

Requirements: **Node 24**, **pnpm 10** and **Docker**.

For a fresh machine, run `pnpm install --frozen-lockfile`, then follow the
[local setup guide](docs/testing/local-live-evaluations.md#local-configuration)
to create your private `.env.local`, configure your own API key and initialize
the disposable demo database. Never share or commit `.env.local`.

If this machine is already configured, start the preserved database and app:

```sh
docker compose -f deploy/local-eval.compose.yml up -d --build --wait
pnpm dev
```

In a second terminal, start the worker for local customer replies:

```sh
pnpm local:worker:bounded
```

Open **http://localhost:3000/login**. Stop the app and worker with **Ctrl+C**;
stop the database with `docker compose -f deploy/local-eval.compose.yml stop`.
Do not rerun fixture setup on a database whose conversations you want to keep.

## Local logins

| Account | Email | Password |
| --- | --- | --- |
| PS.Cafe responder | `responder@ps-cafe-demo.test` | `pronto-ps-demo` |
| Generic seeded operator | `operator@pronto.sg` | `pronto-operator` |
| Generic seeded business owner | `owner@northbridgenasi.sg` | `pronto-client` |

These are **local fixture accounts**, available after the corresponding setup
or seed. Use the PS.Cafe responder for `/demo/customer` and `/client/inbox`.
They are not hosted account passwords; hosted reviewers should use `/enter`.

## Handoff

[Evaluation results and restart notes](docs/testing/evaluation-handoff.md)
cover the 200-scenario campaign and English, Chinese, Bahasa Melayu and Tamil.
Local evaluation uses OpenAI Luna; the hosted demo uses Groq. Paid local testing
is stopped at about **US$1.76 of the original US$5 total limit**. The bounded
worker shares that limit, so keep the existing budget ledger.

Render auto-deploy is enabled for `main`. After pushing, wait for the deployment
to finish in Render before checking the updated site.

Technical guidance, checks and architecture references are in [AGENTS.md](AGENTS.md).
