/**
 * server.js - Entry point
 * 
 * Librus Synergia REST API Proxy
 * 
 * Architektura oparta na kbaraniak/librus-api-rewrited:
 *  - Uwierzytelnianie przez OAuth (src/auth.js)
 *  - Pobieranie danych przez REST gateway/api/2.0 (src/librusApi.js)
 *  - Zero Playwright, zero HTML scrapowania
 *
 * Endpointy:
 *  POST /librus  { login, pass }  → dane ucznia (oceny, frekwencja, plan lekcji)
 *  GET  /health                   → status serwera
 */
"use strict";

const express = require("express");
const cors = require("cors");
const librusRouter = require("./routes/librus");

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use("/librus", librusRouter);

// Health check
app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: "2.0.0", time: new Date().toISOString() });
});

// Nieznane endpointy
app.use((_req, res) => {
    res.status(404).json({ error: "Endpoint nie istnieje." });
});

app.listen(PORT, () => {
    console.log(`[Server] Librus Proxy v2.0 działa na porcie ${PORT}`);
    console.log(`[Server] Architektura: REST JSON API (gateway/api/2.0), bez scrapowania HTML`);
});
