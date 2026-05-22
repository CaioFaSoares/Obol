# 🪙 Obol

Obol is a personal cash flow forecaster designed for granular control, precise financial predictions, and at-a-glance dashboard visualization.

## 🏗️ Architecture (The Triad)

This system is built using a strict 3-layer architecture:

1. **Frontend (Nuxt 3 + Nuxt UI)**: Focuses purely on UX, global state caching (Pinia), and rendering high-performance reactive charts (ECharts). It never talks directly to the database.
2. **BFF (ElysiaJS + Bun)**: The brain of the operation. Orchestrates dashboard payloads, routes credit card invoices dynamically based on closing days, and calculates financial projections mathematically via strict type contracts (Eden Treaty).
3. **Data Layer (PocketBase v0.23+)**: A robust SQLite wrapper running in isolation. Secures the data, handles zero-touch superuser creation, and manages the Parent-Child relation logic (e.g. `recurring_incomes` generating `transactions`).

## 🚀 Quick Start

Obol uses a Nix flake for reproducible development environments and Docker Compose for infrastructure.

1. **Start the Nix Shell** (Requires [Nix](https://nixos.org/download/)):
   ```bash
   nix develop
   ```

2. **Boot the Infrastructure**:
   This will spin up PocketBase, the Nuxt Frontend, the Elysia BFF, and SilverBullet (for Markdown Docs).
   ```bash
   docker-compose up -d --build
   ```

3. **Access the Services**:
   - 🌐 Frontend: [http://localhost:3000](http://localhost:3000)
   - 🛠️ PocketBase Admin: [http://localhost:8090/_/](http://localhost:8090/_/)
   - 📝 Documentation (SilverBullet): [http://localhost:3030](http://localhost:3030)

## 🗄️ Database Migrations

PocketBase migrations are written in JavaScript and executed automatically via the `--automigrate` flag on the first boot. They map exactly to our business rules (Parent-Child data modeling) and reside in `data/pb_migrations/`.
