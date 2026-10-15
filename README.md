This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## OmniFlow customer authentication

The marketing admin/CMS remains on its existing Supabase authentication. The
customer `/dashboard` uses the versioned OmniFlow Control Plane API through
server-side BFF Route Handlers:

- `POST /api/omniflow/auth/login`
- `POST /api/omniflow/auth/refresh`
- `POST /api/omniflow/auth/logout`
- `GET /api/omniflow/auth/me`

Raw access and refresh tokens are stored only in `HttpOnly`, `SameSite=Strict`
cookies. They are never returned to browser JavaScript or stored in
`localStorage`/`sessionStorage`.

Set `OMNIFLOW_CONTROL_PLANE_URL` to the HTTPS origin of the deployed Control
Plane, without `/api/v1`. This variable is server-only and must never use the
`NEXT_PUBLIC_` prefix. See `.env.example`.

Production requires Node.js 22 or newer because of the current Supabase SDK.

## Verification

```bash
python test_auth_source_contract.py
npm run lint
npm run build
```

The optional network test uses the mock Control Plane files under `test/` and
verifies login, secure cookies, refresh rotation, logout, and protected-route
redirects without contacting a real customer database.

## Deploy on Vercel

Configure the environment variables from `.env.example`, select Node.js 22,
and deploy from the connected GitHub repository. The customer login will stay
safely unavailable until `OMNIFLOW_CONTROL_PLANE_URL` points to the live HTTPS
Control Plane.
