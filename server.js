"use strict";
const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Nagłówki wymagane przez api.librus.pl (PR #81 librus-api: Referer jest OBOWIĄZKOWY)
const BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "pl,en-US;q=0.7,en;q=0.3",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
};

// Helper: HTTPS request z obsługą ciasteczek i Referer
function httpsRequest(options, body, cookies, referer) {
    return new Promise((resolve, reject) => {
        const cookieStr = Object.entries(cookies || {})
            .map(([k, v]) => `${k}=${v}`).join("; ");

        const reqHeaders = {
            ...BASE_HEADERS,
            "Cookie": cookieStr,
        };

        if (referer) {
            reqHeaders["Referer"] = referer;
        }

        if (body) {
            reqHeaders["Content-Type"] = "application/x-www-form-urlencoded";
            reqHeaders["Content-Length"] = Buffer.byteLength(body);
        }

        const reqOptions = {
            ...options,
            headers: { ...reqHeaders, ...(options.headers || {}) }
        };

        const req = https.request(reqOptions, (res) => {
            const setCookies = {};
            (res.headers["set-cookie"] || []).forEach(c => {
                const [kv] = c.split(";");
                const eqIdx = kv.indexOf("=");
                if (eqIdx > 0) {
                    setCookies[kv.substring(0, eqIdx).trim()] = kv.substring(eqIdx + 1).trim();
                }
            });

            // Zbierz chunki (może być gzip ale poczekamy na surowe dane)
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => {
                const data = Buffer.concat(chunks).toString("utf8");
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    cookies: setCookies,
                    body: data,
                    location: res.headers["location"] || ""
                });
            });
        });

        req.on("error", reject);
        req.setTimeout(30000, () => {
            req.destroy(new Error("Request timeout"));
        });

        if (body) req.write(body);
        req.end();
    });
}

async function loginLibrus(login, pass) {
    let cookies = {};

    // KROK 1: GET strony logowania - pobierz ciasteczka sesji
    const step1 = await httpsRequest({
        hostname: "api.librus.pl",
        path: "/OAuth/Authorization?client_id=46&response_type=code&scope=mydata",
        method: "GET"
    }, null, {}, "https://portal.librus.pl/rodzina/synergia/loguj");

    Object.assign(cookies, step1.cookies);
    console.log("Step1 status:", step1.status, "cookies:", Object.keys(cookies));

    // KROK 2: POST logowania z Referer (WYMAGANY od Nov 2025)
    const formData = `action=login&login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`;

    const step2 = await httpsRequest({
        hostname: "api.librus.pl",
        path: "/OAuth/Authorization/Grant?client_id=46",
        method: "POST"
    }, formData, cookies, "https://api.librus.pl/OAuth/Authorization?client_id=46&response_type=code&scope=mydata");

    Object.assign(cookies, step2.cookies);
    console.log("Step2 status:", step2.status, "location:", step2.location, "body:", step2.body.substring(0, 200));

    // Sprawdź czy OAuth zwrócił błąd logowania
    if (step2.status === 200 && step2.body.includes("error")) {
        throw new Error("invalid_credentials");
    }

    // KROK 3: Podążaj za redirectem do Synergii
    let redirectPath = step2.location;
    if (!redirectPath && step2.body.includes("code=")) {
        const codeMatch = step2.body.match(/code=([^&"]+)/);
        if (codeMatch) redirectPath = `/OAuth/AuthorizationCode?code=${codeMatch[1]}`;
    }

    if (redirectPath) {
        const isAbsolute = redirectPath.startsWith("http");
        const hostname = isAbsolute ? new URL(redirectPath).hostname : "synergia.librus.pl";
        const path = isAbsolute ? new URL(redirectPath).pathname + new URL(redirectPath).search : redirectPath;

        const step3 = await httpsRequest({
            hostname,
            path,
            method: "GET"
        }, null, cookies, `https://api.librus.pl${step2.location || ""}`);

        Object.assign(cookies, step3.cookies);
        console.log("Step3 status:", step3.status, "cookies now:", Object.keys(cookies));

        // Jeśli kolejny redirect - idź dalej
        if (step3.location) {
            const step4 = await httpsRequest({
                hostname: "synergia.librus.pl",
                path: step3.location.startsWith("/") ? step3.location : new URL(step3.location).pathname + new URL(step3.location).search,
                method: "GET"
            }, null, cookies, `https://synergia.librus.pl${step3.location}`);
            Object.assign(cookies, step4.cookies);
            console.log("Step4 status:", step4.status, "cookies now:", Object.keys(cookies));
        }
    }

    // Weryfikujemy czy mamy ciasteczka sesji Synergii
    if (!cookies["DZIENNIKSID"] && !cookies["SDZIENNIKSID"]) {
        console.log("Brak ciasteczek Synergii. Dostępne:", Object.keys(cookies));
        throw new Error("no_session_cookies");
    }

    return cookies;
}

async function fetchPage(path, cookies, referer) {
    const resp = await httpsRequest({
        hostname: "synergia.librus.pl",
        path,
        method: "GET"
    }, null, cookies, referer || "https://synergia.librus.pl/uczen/index");

    if (resp.status === 302 || resp.status === 301) {
        throw new Error("session_expired");
    }
    return resp.body;
}

function parseGrades(html) {
    if (!html || html.length < 100) return [];
    const results = [];

    // Szukamy tabeli z ocenami (index=1 zgodnie z fix PR #82)
    const tables = html.match(/<table[^>]*class="[^"]*decorated[^"]*"[^>]*>[\s\S]*?<\/table>/gi) || [];
    const gradesTable = tables[1] || tables[0]; // index 1 = właściwa tabela ocen
    if (!gradesTable) return [];

    const rows = gradesTable.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    rows.forEach(row => {
        if (row.includes("<th")) return; // pomiń nagłówki

        const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
        if (cells.length < 2) return;

        const subject = cells[0].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        if (!subject || subject.length < 2) return;

        // Szukaj linków z ocenami (posiadają tytuł z opisem)
        const links = row.match(/<a[^>]*title="([^"]+)"[^>]*>([\d.,+\-\/\\]+)<\/a>/gi) || [];
        links.forEach(link => {
            const titleM = link.match(/title="([^"]*)"/);
            const gradeM = link.match(/>([^<]+)<\/a>/);
            const grade = gradeM?.[1]?.trim();
            if (grade) {
                results.push({
                    subject,
                    grade,
                    desc: titleM?.[1]?.split(";")?.[0]?.trim() || "Ocena"
                });
            }
        });
    });

    return results;
}

function parseAttendance(html) {
    const def = { presence_percentage: 0, unexcused: 0, excused: 0, late: 0 };
    if (!html) return def;

    const m = html.match(/(\d+[,.]?\d*)\s*%/);
    const percent = m ? parseFloat(m[1].replace(",", ".")) : 0;

    let unexcused = 0, excused = 0, late = 0;
    (html.match(/<td[^>]*>([^<]*)<\/td>/gi) || []).forEach(cell => {
        const t = cell.replace(/<[^>]+>/g, "").trim().toLowerCase();
        if (t === "nb" || t === "u") unexcused++;
        else if (t === "nb_u" || t === "uw" || t === "us") excused++;
        else if (t === "sp") late++;
    });

    return { presence_percentage: percent, unexcused, excused, late };
}

function parseTimetable(html) {
    if (!html) return [];
    const lessons = [];
    const days = ["Pn", "Wt", "Śr", "Czw", "Pt"];

    (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []).forEach(row => {
        const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || [];
        if (cells.length < 2) return;
        const time = cells[0].replace(/<[^>]+>/g, "").trim();

        cells.slice(1).forEach((cell, idx) => {
            if (idx >= 5) return;
            const textM = cell.match(/class="text"[^>]*>([\s\S]*?)<\/\w+>/i);
            const roomM = cell.match(/class="classroom"[^>]*>([^<]+)/i);
            const subject = textM?.[1]?.replace(/<[^>]+>/g, "")?.trim();
            if (subject) {
                lessons.push({ day: days[idx], subject, room: roomM?.[1]?.trim() || "-", time });
            }
        });
    });

    return lessons;
}

// Główny endpoint
app.post("/librus", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) return res.status(400).json({ error: "Brak danych logowania." });

    try {
        let cookies;
        try {
            cookies = await loginLibrus(login, pass);
        } catch (err) {
            if (err.message === "invalid_credentials") {
                return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
            }
            if (err.message === "no_session_cookies") {
                return res.status(401).json({ error: "Nie udało się uzyskać sesji Synergii." });
            }
            throw err;
        }

        // Pobierz dane równolegle
        const [gradesRes, attendanceRes, timetableRes] = await Promise.allSettled([
            fetchPage("/przegladaj_oceny/uczen", cookies),
            fetchPage("/przegladaj_nb/uczen", cookies),
            fetchPage("/przegladaj_plan_lekcji", cookies)
        ]);

        const grades = gradesRes.status === "fulfilled" ? parseGrades(gradesRes.value) : [];
        const attendance = attendanceRes.status === "fulfilled" ? parseAttendance(attendanceRes.value) : { presence_percentage: 0 };
        const timetable = timetableRes.status === "fulfilled" ? parseTimetable(timetableRes.value) : [];

        return res.json({ status: "success", data: { grades, attendance, timetable } });

    } catch (err) {
        console.error("Error:", err.message, err.stack?.split("\n")[1]);
        return res.status(500).json({ error: "Błąd serwera: " + err.message });
    }
});

// Endpoint diagnostyczny
app.post("/debug-login", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) return res.status(400).json({ error: "Brak danych." });

    const debug = {};
    try {
        const step1 = await httpsRequest({
            hostname: "api.librus.pl",
            path: "/OAuth/Authorization?client_id=46&response_type=code&scope=mydata",
            method: "GET"
        }, null, {}, "https://portal.librus.pl/rodzina/synergia/loguj");
        debug.step1 = { status: step1.status, cookies: step1.cookies };

        const formData = `action=login&login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`;
        const step2 = await httpsRequest({
            hostname: "api.librus.pl",
            path: "/OAuth/Authorization/Grant?client_id=46",
            method: "POST"
        }, formData, step1.cookies, "https://api.librus.pl/OAuth/Authorization?client_id=46&response_type=code&scope=mydata");
        debug.step2 = { status: step2.status, cookies: step2.cookies, location: step2.location, body: step2.body.substring(0, 300) };

        return res.json(debug);
    } catch (err) {
        return res.status(500).json({ error: err.message, debug });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Librus OAuth Proxy running on port ${PORT}`));
