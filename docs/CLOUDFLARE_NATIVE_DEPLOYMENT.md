# Cloudflare Native Deployment

This project now supports scheme C: one Cloudflare Worker serves the React frontend and the native `/api` backend on the same `workers.dev` URL. A custom domain, Cloudflare Tunnel, and `API_ORIGIN` are not required for the first public deployment.

## GitHub Repository Secrets

Create these in `Settings -> Secrets and variables -> Actions -> Repository secrets`:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token with Workers Scripts edit/deploy permission for this account. |
| `CLOUDFLARE_ACCOUNT_ID` | The 32-character Cloudflare account id. |
| `CLOUDFLARE_DEPLOYMENT_URL` | The Worker public URL, for example `https://deep-oa-hr.2445776963.workers.dev`. |

Do not add `API_ORIGIN` for scheme C. The Worker runs the API directly.

## First Deploy

1. Push to `main`, or run the `Deploy HR OA to Cloudflare` GitHub Action manually.
2. The workflow runs `npm run build`, deploys with `wrangler deploy`, then smokes:

```bash
npm run smoke:cloudflare -- --url https://deep-oa-hr.2445776963.workers.dev --json
```

## Optional D1 Persistence

The Worker can run without D1 for public preview, but formal production persistence requires D1:

```bash
npx wrangler d1 create deep-oa-hr
```

Copy the returned `database_id` into the commented `[[d1_databases]]` block in `wrangler.toml`, then apply the schema:

```bash
npm run cf:d1:schema
```

After that, deploy again. `/api/edge/health` should report `d1Configured: true`.
