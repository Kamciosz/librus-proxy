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
 * Generuje nagłówek x-baner identyczny do tego, który przesyła przeglądarka
 * przez api.librus.pl/OAuth/js/Authorization.js (anti-bot check serwera).
 * Algorytm: każdy znak w stringu jest przesuwany o +20 w ASCII.
 *   x-baner = encode(Math.random()) + "_" + encode(Date.now())
 */
function generateXBaner() {
    const encode = (str) => str.split("").map(c => String.fromCharCode(c.charCodeAt(0) + 20)).join("");
    return encode(Math.random().toString()) + "_" + encode(Date.now().toString());
}

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
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46&response_type=code&scope=mydata`,
                "x-baner": generateXBaner(),
            }
        });
        trace.step2 = { status: r2.status, data: r2.data, cookiesForApi: (await jar.getCookies("https://api.librus.pl")).map(c => c.key) };

        if (r2.data?.status === "error" || r2.data?.errors) {
            return res.json({ ...trace, conclusion: "INVALID_CREDENTIALS" });
        }

        trace.goToFromLogin = r2.data?.goTo;

        // Client BEZ redirect dla przechwytywania Location headers
        const clientNoRedir = wrapper(axios.create({
            jar, timeout: 15000, maxRedirects: 0,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept-Encoding": "identity" },
            validateStatus: () => true,
        }));

        // KROK 3: Śledzimy goTo zwrócone przez login (/2FA dla kont studenckich)
        const goToPath = r2.data?.goTo || "/OAuth/Authorization/Grant?client_id=46";
        const goToUrl = goToPath.startsWith("http") ? goToPath : `${OAUTH_BASE}${goToPath}`;
        const r3goto = await clientNoRedir.get(goToUrl, {
            headers: { "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46` }
        });
        const gotoLocation = r3goto.headers?.location || "";
        const gotoBody = typeof r3goto.data === "string" ? r3goto.data.substring(0, 200) : JSON.stringify(r3goto.data).substring(0, 200);
        trace.step3_goto = {
            url: goToUrl,
            status: r3goto.status,
            locationHeader: gotoLocation,
            bodyPreview: gotoBody,
        };

        // KROK 4: Jeśli /2FA → redirect do /Grant lub bezpośrednio do synergia
        let finalOauthCode = null;
        let finalSynergiaUrl = null;

        if (gotoLocation.includes("/Grant")) {
            // Przypadek A: /2FA → /Grant → kod OAuth
            const grantUrl = gotoLocation.startsWith("http") ? gotoLocation : `${OAUTH_BASE}${gotoLocation}`;
            const r4grant = await clientNoRedir.get(grantUrl, { headers: { "Referer": goToUrl } });
            const grantLoc = r4grant.headers?.location || "";
            const codeMatch = grantLoc.match(/[?&]code=([^&]+)/);
            finalOauthCode = codeMatch ? decodeURIComponent(codeMatch[1]) : null;
            finalSynergiaUrl = grantLoc;
            trace.step4_grant = { status: r4grant.status, locationHeader: grantLoc.substring(0, 80), codeFound: !!finalOauthCode };
        } else if (gotoLocation.includes("code=")) {
            // Przypadek B: /2FA daje bezpośrednio kod OAuth
            const codeMatch = gotoLocation.match(/[?&]code=([^&]+)/);
            finalOauthCode = codeMatch ? decodeURIComponent(codeMatch[1]) : null;
            finalSynergiaUrl = gotoLocation;
            trace.step4_directCode = { locationHeader: gotoLocation.substring(0, 80), codeFound: !!finalOauthCode };
        } else if (r3goto.status === 200) {
            trace.step4_2faPage = { note: "/2FA zwraca formularz HTML - może wymaga dodatkowego POSTa", bodyPreview: gotoBody };
        }

        // KROK 5: Podążamy za kodem OAuth do Synergia (jeśli mamy)
        if (finalSynergiaUrl && finalSynergiaUrl.startsWith("http")) {
            const r5 = await client.get(finalSynergiaUrl, { headers: { "Referer": goToUrl } });
            trace.step5_synergiaRedirect = {
                finalUrl: r5.request?.res?.responseUrl,
                status: r5.status,
                dzienniksid: (await jar.getCookies("https://synergia.librus.pl")).find(c => c.key === "DZIENNIKSID")?.value?.substring(0, 20),
                allSynergiaCookies: (await jar.getCookies("https://synergia.librus.pl")).map(c => c.key),
            };
        }

        // KROK 6: Testujemy czy jesteśmy zalogowani przez TokenInfo
        const r6 = await client.get(`${GATEWAY_BASE}/Auth/TokenInfo`, { timeout: 10000 });
        trace.step6_tokenInfo = { status: r6.status, data: r6.data };

        // KROK 7: Testujemy synergia HTML (uczen/index)
        const r7 = await client.get("https://synergia.librus.pl/uczen/index", { timeout: 10000 });
        trace.step7_htmlSynergia = {
            status: r7.status,
            finalUrl: r7.request?.res?.responseUrl,
            bodyPreview: typeof r7.data === "string" ? r7.data.substring(0, 150) : "json",
        };

        // KROK 8: Tesujemy /Grant HARDcoded dla porównania (jeśli jeszcze nie tesotwaliśmy)
        if (!goToPath.includes("Grant")) {
            const r8grant = await clientNoRedir.get(`${OAUTH_BASE}/OAuth/Authorization/Grant?client_id=46`, {
                headers: { "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46` }
            });
            const r8loc = r8grant.headers?.location || "";
            trace.step8_grantHardcoded = { status: r8grant.status, locationHeader: r8loc.substring(0, 80) };
        }

        const conclusion = r6.data?.UserIdentifier
            ? `AUTH_OK: ${r6.data.UserIdentifier}`
            : r7.status === 200 ? "HTML_OK_BUT_GATEWAY_401" : "ALL_FAILED";
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
