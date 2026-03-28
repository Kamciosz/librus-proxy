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

import express from "express";
import cors from "cors";
import librusRouter from "./routes/librus.js";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { OAUTH_BASE, GATEWAY_BASE } from "./src/auth.js";

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

/**
 * GET /debug-gateway
 * Drobiazgowy test: co zwraca TokenInfo BEZ żadnej sesji z Railway?
 * Odpowiedź pokaże czy Railway IP jest traktowane inaczej niż zwykłe.
 */
app.get("/debug-gateway", async (_req, res) => {
    try {
        const response = await axios.get(`${GATEWAY_BASE}/Auth/TokenInfo`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept-Encoding": "identity",
                "Referer": "https://portal.librus.pl/rodzina/synergia/loguj",
            },
            timeout: 10000,
            validateStatus: () => true, // nie rzucaj na żadny status
        });
        res.json({ http_status: response.status, body: response.data, headers: response.headers });
    } catch (err) {
        res.json({ error: err.message });
    }
});

/**
 * POST /debug-auth
 * Pełny trace OAuth flow krok po kroku z logiem co każdy krok zwrócił.
 * Body: { login, pass }
 * Używać TYLKO do debugowania — ujawnia detale auth flow.
 */
app.post("/debug-auth", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) return res.status(400).json({ error: "Brak login/pass" });

    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        timeout: 30000,
        maxRedirects: 10,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept-Encoding": "identity",
            "Referer": "https://portal.librus.pl/rodzina/synergia/loguj",
        },
        validateStatus: () => true, // nigdy nie rzucaj — chcemy zobaczyć każdy status
    }));

    const trace = {};

    try {
        // Krok 1
        const r1 = await client.get(`${OAUTH_BASE}/OAuth/Authorization?client_id=46&response_type=code&scope=mydata`);
        trace.step1 = { status: r1.status, finalUrl: r1.request?.res?.responseUrl, cookiesForApi: (await jar.getCookies("https://api.librus.pl")).map(c => c.key) };

        // Krok 2 - login
        const form = new URLSearchParams();
        form.append("action", "login");
        form.append("login", login);
        form.append("pass", pass);
        const r2 = await client.post(`${OAUTH_BASE}/OAuth/Authorization?client_id=46`, form.toString(), {
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46&response_type=code&scope=mydata` }
        });
        trace.step2 = { status: r2.status, data: r2.data, cookiesForApi: (await jar.getCookies("https://api.librus.pl")).map(c => c.key) };

        if (r2.data?.status === "error" || r2.data?.errors) {
            return res.json({ ...trace, conclusion: "INVALID_CREDENTIALS" });
        }

        // Krok 3 - Grant (używamy goTo z loginResponse jeśli istnieje!)
        const grantUrl = r2.data?.goTo ? (r2.data.goTo.startsWith("http") ? r2.data.goTo : `${OAUTH_BASE}${r2.data.goTo}`) : `${OAUTH_BASE}/OAuth/Authorization/Grant?client_id=46`;
        trace.grantUrl = grantUrl;
        const r3 = await client.get(grantUrl, { headers: { "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46` } });
        trace.step3 = {
            status: r3.status,
            finalUrl: r3.request?.res?.responseUrl,
            cookiesForApi: (await jar.getCookies("https://api.librus.pl")).map(c => c.key),
            cookiesForSynergia: (await jar.getCookies("https://synergia.librus.pl")).map(c => `${c.key}=${c.value.substring(0, 10)}...`),
            cookiesForPortal: (await jar.getCookies("https://portal.librus.pl")).map(c => c.key),
            bodyPreview: typeof r3.data === "string" ? r3.data.substring(0, 300) : JSON.stringify(r3.data).substring(0, 300),
        };

        // Krok 4 - TokenInfo
        const r4 = await client.get(`${GATEWAY_BASE}/Auth/TokenInfo`, { timeout: 10000 });
        trace.step4_tokenInfo = {
            status: r4.status,
            data: r4.data,
            cookiesSent: (await jar.getCookies("https://synergia.librus.pl")).map(c => `${c.key}=${c.value.substring(0, 10)}...`),
        };

        return res.json({ ...trace, conclusion: r4.data?.UserIdentifier ? "AUTH_OK" : "NO_USER_IDENTIFIER" });
    } catch (err) {
        return res.json({ ...trace, error: err.message, stack: err.stack?.split("\n").slice(0, 5) });
    }
});

// Nieznane endpointy
app.use((_req, res) => {
    res.status(404).json({ error: "Endpoint nie istnieje." });
});

app.listen(PORT, () => {
    console.log(`[Server] Librus Proxy v2.0 działa na porcie ${PORT}`);
    console.log(`[Server] Architektura: REST JSON API (gateway/api/2.0), bez scrapowania HTML`);
});
