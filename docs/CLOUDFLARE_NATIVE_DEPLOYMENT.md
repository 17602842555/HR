# Cloudflare Native Deployment

This project now supports scheme C: Cloudflare Worker runs the native `/api` backend, and the frontend can be opened either from GitHub Pages or the same `workers.dev` preview URL. A custom domain, Cloudflare Tunnel, and `API_ORIGIN` are not required for the first public deployment.

## GitHub Repository Secrets

Create these in `Settings -> Secrets and variables -> Actions -> Repository secrets`:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with Workers Scripts edit/deploy permission for this account. |
| `CLOUDFLARE_ACCOUNT_ID` | The 32-character Cloudflare account id. |
| `CLOUDFLARE_DEPLOYMENT_URL` | The Worker public URL, for example `https://deep-oa-hr.2445776963.workers.dev`. |

Do not add `API_ORIGIN` for scheme C. The Worker runs the API directly.

## Public Frontend URL

The `Deploy HR OA frontend to GitHub Pages` workflow builds the Vite frontend with:

| Build variable | Value |
| --- | --- |
| `VITE_BASE_PATH` | `/HR/` |
| `VITE_API_BASE_URL` | `https://deep-oa-hr.2445776963.workers.dev/api` or the configured `CLOUDFLARE_DEPLOYMENT_URL` plus `/api` |
| `VITE_REQUIRE_API` | `1` |

After GitHub Pages is enabled for Actions, the public frontend URL is:

```text
https://17602842555.github.io/HR/
```

The Worker allows credentialed API calls from `https://17602842555.github.io`, so the GitHub Pages frontend can log in and use the Cloudflare backend directly.

## First Deploy

1. Push to `main`, or run the `Deploy HR OA to Cloudflare` GitHub Action manually.
2. The Cloudflare workflow runs `npm run build`, deploys with `wrangler deploy`, then smokes:

```bash
npm run smoke:cloudflare -- --url https://deep-oa-hr.2445776963.workers.dev --json
```
3. The GitHub Pages workflow publishes the frontend artifact from `dist`.

## D1 Persistence

The public deployment is now expected to run with D1 persistence. The current binding in `wrangler.toml` is:

```toml
[[d1_databases]]
binding = "OA_DB"
database_name = "deep-oa-hr"
database_id = "0ec260d6-3e76-4c51-a5dc-58dc321cee1b"
```

If a new Cloudflare account or database is used later, recreate the database and replace only `database_id`:

```bash
npx wrangler d1 create deep-oa-hr
```

Then apply the schema:

```bash
npm run cf:d1:schema
```

After deploy, `/api/edge/health` and `npm run smoke:cloudflare -- --url <worker-url> --json` must report `d1Configured: true`.

## Native Deployment Doctor

Because this project currently has no custom domain, validate the live deployment in native-worker mode:

```bash
npm run doctor:cloudflare -- --repo 17602842555/HR --url https://deep-oa-hr.2445776963.workers.dev --json
```

This should pass with the three repository secrets required for scheme C: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_DEPLOYMENT_URL`. Tunnel-only checks are not required unless a future custom domain and Cloudflare Tunnel are introduced.
