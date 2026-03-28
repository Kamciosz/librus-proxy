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

        // ===== TEST: Hardcoded /Grant, JEDEN request z redirect =====
        // Odkrycie: /Grant → 302 → synergia.librus.pl/loguj/portalRodzina?code=XXX
        // Poprzednio clientNoRedirect + client robiły DWA requesty → code invalid_request
        trace.goToFromLogin = r2.data?.goTo;
        trace.hypothesis = "Test 1: czy DZIENNIKSID po /Grant działa dla HTML Synergii? Test 2: przechwytujemy code z /Grant dla /OAuth/Token";

        const grantUrlHardcoded = `${OAUTH_BASE}/OAuth/Authorization/Grant?client_id=46`;

        // KROK 3: /Grant BEZ redirect - przechwytujemy Location header (OAuth code)
        const clientNoRedir = wrapper(axios.create({
            jar, timeout: 15000, maxRedirects: 0,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept-Encoding": "identity" },
            validateStatus: () => true,
        }));
        const r3raw = await clientNoRedir.get(grantUrlHardcoded, { headers: { "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46` } });
        const locationHeader = r3raw.headers?.location || "";
        const codeMatch = locationHeader.match(/[?&]code=([^&]+)/);
        const oauthCode = codeMatch ? decodeURIComponent(codeMatch[1]) : null;
        const redirectUri = "https://synergia.librus.pl/loguj/portalRodzina";
        trace.step3_grantRaw = {
            status: r3raw.status,
            locationHeader,
            oauthCodeFound: !!oauthCode,
            oauthCodePreview: oauthCode ? oauthCode.substring(0, 20) + "..." : null,
        };

        // Teraz PODĄŻAMY za redirect manualnie do synergia (jednorazowe użycie code)
        if (locationHeader && locationHeader.startsWith("http")) {
            const r3synergia = await client.get(locationHeader, { headers: { "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46` } });
            trace.step3_synergiaRedirect = {
                finalUrl: r3synergia.request?.res?.responseUrl,
                status: r3synergia.status,
                synergiaCookies: (await jar.getCookies("https://synergia.librus.pl")).map(c => `${c.key}=${c.value.substring(0, 12)}...`),
            };
        }

        // KROK 3.5: Sprawdzamy czy HTML Synergii działa (uczen/index)
        const r3html = await client.get("https://synergia.librus.pl/uczen/index", { timeout: 10000 });
        trace.step3_htmlSynergia = {
            status: r3html.status,
            finalUrl: r3html.request?.res?.responseUrl,
            isRedirectedToLogin: r3html.request?.res?.responseUrl?.includes("loguj") ?? false,
            bodyPreview: typeof r3html.data === "string" ? r3html.data.substring(0, 200) : JSON.stringify(r3html.data).substring(0, 200),
        };

        // KROK 4: TEST A - Gateway TokenInfo z cookies
        const r4a = await client.get(`${GATEWAY_BASE}/Auth/TokenInfo`, { timeout: 10000 });
        trace.step4_tokenInfoCookies = { status: r4a.status, data: r4a.data };

        // KROK 4: TEST B - POST /OAuth/Token (exchange code → Bearer token)
        if (oauthCode) {
            const tokenForm = new URLSearchParams();
            tokenForm.append("grant_type", "authorization_code");
            tokenForm.append("code", oauthCode);
            tokenForm.append("client_id", "46");
            tokenForm.append("redirect_uri", redirectUri);
            const r4token = await client.post(`${OAUTH_BASE}/OAuth/Token`, tokenForm.toString(), {
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            });
            trace.step4_oauthToken = { status: r4token.status, data: r4token.data };

            // Jeśli dostaliśmy Bearer token, testujemy gateway z nim
            if (r4token.data?.access_token) {
                const r4bearer = await axios.get(`${GATEWAY_BASE}/Auth/TokenInfo`, {
                    headers: { "Authorization": `Bearer ${r4token.data.access_token}` },
                    timeout: 10000, validateStatus: () => true,
                });
                trace.step4_tokenInfoBearer = { status: r4bearer.status, data: r4bearer.data };
            }
        }

        // KROK 5: refreshToken na synergia (librus-apix używa tego)
        const r5refresh = await client.get("https://synergia.librus.pl/refreshToken", { timeout: 10000 });
        trace.step5_refreshToken = {
            status: r5refresh.status,
            finalUrl: r5refresh.request?.res?.responseUrl,
            oauthTokenCookie: (await jar.getCookies("https://synergia.librus.pl")).find(c => c.key === "oauth_token")?.value?.substring(0, 20),
            data: typeof r5refresh.data === "string" ? r5refresh.data.substring(0, 200) : JSON.stringify(r5refresh.data).substring(0, 200),
        };

        const conclusion = r4a.data?.UserIdentifier ? "AUTH_OK_COOKIES" : (trace.step4_tokenInfoBearer?.data?.UserIdentifier ? "AUTH_OK_BEARER" : "ALL_FAILED");
        return res.json({ ...trace, conclusion });
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
