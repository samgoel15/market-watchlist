# Backend setup

1. Copy every file here into your existing `backend/` folder (matching the
   structure you already have in VS Code: routes/watchlist.js goes in
   backend/routes/).
2. Rename `.env.example` to `.env` and fill in your real DATABASE_URL.
3. Run:
   npm install express pg cors dotenv
   npm install -D nodemon
4. Load the schema into your database:
   psql "$DATABASE_URL" -f schema.sql
   (or run schema.sql through your Postgres GUI/hosted provider's SQL editor)
5. Add to package.json scripts: "dev": "nodemon server.js"
6. Run: npm run dev
7. Test: curl http://localhost:3000/watchlist/1/changes
   Should return JSON (likely an empty/error-free list until you seed data),
   not a crash.
