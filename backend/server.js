require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { startIngestion } = require('./ingest');

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Temporary auth stub until real auth exists — replace with real middleware later.
app.use((req, res, next) => {
  req.user = { id: 1 };
  next();
});

app.use('/', require('./routes/watchlist'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
startIngestion();
