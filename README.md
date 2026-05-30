# Scalyooo — SaaS ERP & Affiliate Dashboard

A multi-tenant SaaS platform built with **Next.js 14** (App Router) on the frontend and **Node.js / Express** on the backend, backed by **PostgreSQL** (Supabase).

Features order confirmation, inventory, treasury, Meta Ads sync, Bosta shipping integration, and a full Affiliate plan (Taager & Safqa).

---

## Project structure

```
scalyooo/
├── backend/      Node.js / Express API
└── frontend/     Next.js 14 App Router UI
```

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 18 LTS |
| npm | 9+ |
| PostgreSQL | 14+ (Supabase project recommended) |
| Git | any recent |

---

## Quick start

### 1 · Clone the repo

```bash
git clone https://github.com/Mohamed7ammad/scalyooo.git
cd scalyooo
```

### 2 · Backend setup

```bash
cd backend
npm install
```

Copy the environment template and fill in every value:

```bash
cp .env.example .env
# Then open .env in your editor and fill in the values
```

**Required variables** (see `backend/.env.example` for the full list with descriptions):

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string (Supabase URI) |
| `JWT_SECRET` | Long random string for signing auth tokens |
| `PORT` | Port to listen on (default `4000`) |
| `FRONTEND_URL` | URL of the Next.js dev server (default `http://localhost:3000`) |
| `WEBHOOK_SECRET` | Secret for incoming webhook verification |
| `BOSTA_*` | Bosta shipping API credentials (optional if not using Bosta) |

Generate a secure `JWT_SECRET` in one command:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Start the backend dev server:
```bash
node src/index.js
# or with auto-restart:
npx nodemon src/index.js
```

The API will be available at **http://localhost:4000**.

---

### 3 · Frontend setup

```bash
cd ../frontend
npm install
```

Copy the environment template:

```bash
cp .env.local.example .env.local
# Open .env.local and set NEXT_PUBLIC_API_URL
```

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_API_URL` | URL of the running backend, e.g. `http://localhost:4000` |

Start the frontend dev server:

```bash
npm run dev
```

The app will be available at **http://localhost:3000**.

---

## Running both servers simultaneously

Open two terminals and run one command in each:

**Terminal 1 — backend:**
```bash
cd backend && node src/index.js
```

**Terminal 2 — frontend:**
```bash
cd frontend && npm run dev
```

---

## Database

The backend auto-migrates the schema on every startup via `src/config/initTenancy.js` — no manual SQL required for a fresh install. If you want to inspect the base schema, see `backend/schema.sql`.

For Supabase, copy the `DATABASE_URL` connection string from:
> Supabase dashboard → Project Settings → Database → Connection string (URI mode)

---

## Environment files

| File | Purpose | In repo? |
|------|---------|----------|
| `backend/.env` | Real backend secrets | ❌ gitignored |
| `backend/.env.example` | Template with descriptions | ✅ committed |
| `frontend/.env.local` | Real frontend env | ❌ gitignored |
| `frontend/.env.local.example` | Template | ✅ committed |

> ⚠️ **Never commit `.env` or `.env.local`** — they contain real credentials and are strictly gitignored.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React, TypeScript, Tailwind CSS |
| Backend | Node.js, Express |
| Database | PostgreSQL via Supabase |
| Auth | JWT (jsonwebtoken) |
| Shipping | Bosta API |
| Ads | Meta Ads Graph API |
| Affiliate | Taager & Safqa public APIs |

---

## Contributing

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Commit your changes: `git commit -m "Add my feature"`
3. Push the branch: `git push origin feature/my-feature`
4. Open a Pull Request on GitHub
