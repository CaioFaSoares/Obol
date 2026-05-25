# 🪙 Obol

Obol is a personal cash flow forecaster designed for granular control, precise financial predictions, and at-a-glance dashboard visualization. Unlike traditional static budgeting tools, Obol projects your daily balance into the future, helping you visualize the exact day a cash crunch might occur.

## 🏗️ Architecture (The Triad)

This system is built using a strict 3-layer architecture:

1. **App (Nuxt 3 + Nuxt UI)**: Focuses purely on UX, global state caching (Pinia), and rendering high-performance reactive charts (ECharts). It implements optimistic UI updates and never talks directly to the database.
2. **Server (ElysiaJS + Bun)**: The brain of the operation. Orchestrates dashboard payloads, calculates mathematical projections via strict type contracts (Eden Treaty), and runs the **Virtual Invoices Engine** to resolve credit card billing cycles on the fly.
3. **Data Layer (PocketBase v0.23+)**: A robust SQLite wrapper running in isolation. Secures the data, handles zero-touch superuser creation, and manages the Relational mapping via Javascript migrations.

## ✨ Core Features

* **Advanced Credit Card Handling**: Obol separates *credit consumption* from *cash outflow*. Credit card transactions consume category budgets on the exact date of purchase (`purchase_date`), but only impact your checking account cashflow projection on the invoice due date.
* **Flexible Invoices**: Automatically groups pending card expenses into Monthly Invoices. Supports partial payments, early full payments, and automatic transaction matching to ensure your cash flow trajectory stays completely accurate.
* **Category Budgets**: Track your monthly "pots" in real-time. Budgets are strictly enforced on an accrual basis, meaning spending on credit cards immediately debits your budget allowance for that month, avoiding false surpluses.
* **Cashflow Trajectory**: A dynamic ECharts projection line that maps your checking account balance up to 90 days into the future, accounting for all pending bills, credit card invoices, and recurring incomes.
* **Interactive Editing**: A seamless UX that allows for quick-editing transaction values, modifying credit card limits, and managing financial recurrences directly from the UI without page reloads.

## 🚀 Quick Start

Obol uses a Nix flake for reproducible development environments and Docker Compose for infrastructure.

1. **Start the Nix Shell** (Requires [Nix](https://nixos.org/download/)):
   ```bash
   nix develop
   ```

2. **Environment Setup**:
   Before starting the containers, set up your `.env` file based on the provided example. This is important to configure secure credentials (like PocketBase admin access).
   ```bash
   cp .env.example .env
   ```
   *Note: Open `.env` and change `PB_ADMIN_PASSWORD` to a secure password.*

3. **Boot the Infrastructure**:
   This will spin up PocketBase, the Nuxt App, the Elysia Server, and SilverBullet (for Markdown Docs).
   ```bash
   docker-compose up -d --build
   ```

4. **Access the Services**:
   - 🌐 App: [http://localhost:3000](http://localhost:3000)
   - 🛠️ PocketBase Admin: [http://localhost:8090/_/](http://localhost:8090/_/)
   - 📝 Documentation (SilverBullet): [http://localhost:3030](http://localhost:3030)

## 🗄️ Database Migrations

PocketBase migrations are written in JavaScript and executed automatically on boot. They map exactly to our business rules (like the addition of `purchase_date` for accrual tracking) and reside in `db/pb_migrations/`.
