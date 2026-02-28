"use strict";
const express = require("express");
const cors = require("cors");
const https = require("https");
const cheerio = require("cheerio"); // Jak w Mati365/librus-api

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Nagłówki wymagane przez api.librus.pl
// WAŻNE: Referer jest OBOWIĄZKOWY (fix z PR #81 librus-api - bez niego TLS handshake zawiesza się)
// WAŻNE: Accept-Encoding: identity - unikamy gzip żeby nie dekodować ręcznie
const BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "pl,en-US;q=0.7,en;q=0.3",
    "Accept-Encoding": "identity",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
};

function httpsRequest(options, body, cookies, referer) {
    return new Promise((resolve, reject) => {
        const cookieStr = Object.entries(cookies || {})
            .map(([k, v]) => `${k}=${v}`).join("; ");

        const reqHeaders = { ...BASE_HEADERS, "Cookie": cookieStr };
        if (referer) reqHeaders["Referer"] = referer;
        if (body) {
            reqHeaders["Content-Type"] = "application/x-www-form-urlencoded";
            reqHeaders["Content-Length"] = Buffer.byteLength(body);
        }

        const req = https.request({ ...options, headers: { ...reqHeaders, ...(options.headers || {}) } }, (res) => {
            const setCookies = {};
            (res.headers["set-cookie"] || []).forEach(c => {
                const eqIdx = c.indexOf("=");
                const semi = c.indexOf(";");
                if (eqIdx > 0) {
                    const key = c.substring(0, eqIdx).trim();
                    const val = c.substring(eqIdx + 1, semi > eqIdx ? semi : undefined).trim();
                    setCookies[key] = val;
                }
            });

            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve({
                status: res.statusCode,
                headers: res.headers,
                cookies: setCookies,
                body: Buffer.concat(chunks).toString("utf8"),
                location: res.headers["location"] || ""
            }));
        });

        req.on("error", reject);
        req.setTimeout(30000, () => req.destroy(new Error("timeout")));
        if (body) req.write(body);
        req.end();
    });
}

// OAuth flow - wzorowane na Mati365/librus-api authorize():
// GET Authorization → POST Grant (z Referer!) → GET 2FA → ciasteczka Synergii
async function loginLibrus(login, pass) {
    let cookies = {};

    // KROK 1: GET - zainicjuj sesję OAuth
    const step1 = await httpsRequest({
        hostname: "api.librus.pl",
        path: "/OAuth/Authorization?client_id=46&response_type=code&scope=mydata",
        method: "GET"
    }, null, {}, "https://portal.librus.pl/rodzina/synergia/loguj");

    Object.assign(cookies, step1.cookies);
    console.log("Step1:", step1.status, Object.keys(cookies));

    // KROK 2: POST - zaloguj dane (Referer WYMAGANY od Nov 2025!)
    const formData = `action=login&login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`;
    const step2 = await httpsRequest({
        hostname: "api.librus.pl",
        path: "/OAuth/Authorization/Grant?client_id=46",
        method: "POST"
    }, formData, cookies, "https://api.librus.pl/OAuth/Authorization?client_id=46&response_type=code&scope=mydata");

    Object.assign(cookies, step2.cookies);
    console.log("Step2:", step2.status, step2.body.substring(0, 100));

    // Parsuj odpowiedź JSON z goTo (Librus mówi gdzie iść dalej)
    let goTo = step2.location;
    if (!goTo && step2.body) {
        try {
            const parsed = JSON.parse(step2.body);
            if (parsed.status === "ok" && parsed.goTo) {
                goTo = parsed.goTo;
            } else if (parsed.status === "error" || parsed.errors) {
                throw new Error("invalid_credentials");
            }
        } catch (e) {
            if (e.message === "invalid_credentials") throw e;
            if (step2.body.includes("error")) throw new Error("invalid_credentials");
        }
    }
    console.log("goTo:", goTo);

    // KROK 3: GET 2FA/consent endpoint (librus-api authorize() też go wywołuje)
    if (goTo) {
        const path3 = goTo.startsWith("/") ? goTo : "/" + goTo.split("/").slice(3).join("/");
        const step3 = await httpsRequest({
            hostname: "api.librus.pl",
            path: path3,
            method: "GET"
        }, null, cookies, "https://api.librus.pl/OAuth/Authorization/Grant?client_id=46");

        Object.assign(cookies, step3.cookies);
        console.log("Step3:", step3.status, step3.location, step3.body.substring(0, 100));

        // Podążaj za redirectem do Synergii
        const next = step3.location || (() => {
            try { return JSON.parse(step3.body).goTo || ""; } catch { return ""; }
        })();

        if (next) {
            const isAbs = next.startsWith("http");
            const host = isAbs ? new URL(next).hostname : "synergia.librus.pl";
            const path4 = isAbs ? new URL(next).pathname + new URL(next).search : next;

            const step4 = await httpsRequest({ hostname: host, path: path4, method: "GET" },
                null, cookies, `https://api.librus.pl${path3}`);
            Object.assign(cookies, step4.cookies);
            console.log("Step4:", step4.status, Object.keys(cookies));

            if (step4.location) {
                const loc = step4.location;
                const step5 = await httpsRequest({
                    hostname: "synergia.librus.pl",
                    path: loc.startsWith("/") ? loc : new URL(loc).pathname + new URL(loc).search,
                    method: "GET"
                }, null, cookies, "https://synergia.librus.pl");
                Object.assign(cookies, step5.cookies);
                console.log("Step5:", step5.status, Object.keys(cookies));
            }
        }
    }

    if (!cookies["DZIENNIKSID"] && !cookies["SDZIENNIKSID"]) {
        throw new Error("no_session_cookies: " + JSON.stringify(Object.keys(cookies)));
    }

    return cookies;
}

async function fetchPage(path, cookies) {
    const resp = await httpsRequest({
        hostname: "synergia.librus.pl",
        path,
        method: "GET"
    }, null, cookies, "https://synergia.librus.pl/uczen/index");

    if (resp.status === 302 || resp.status === 301) throw new Error("session_expired");
    return resp.body;
}

// parseGrades - wzorowane na librus-api (PR #82: tylko table[1] to właściwa tabela)
function parseGrades(html) {
    if (!html || html.length < 100) return [];
    const $ = cheerio.load(html);
    const results = [];

    const tables = $("table.decorated");
    const gradesTable = tables.length > 1 ? $(tables[1]) : $(tables[0]);

    gradesTable.find("tbody tr").each((_, row) => {
        const cells = $(row).children("td");
        if (cells.length < 2) return;

        const subject = $(cells[0]).text().trim();
        if (!subject || subject.length < 2) return;

        $(row).find("a[title]").each((_, link) => {
            const grade = $(link).text().trim();
            const title = $(link).attr("title") || "";
            if (grade) {
                results.push({
                    subject,
                    grade,
                    desc: title.split(";")[0]?.trim() || "Ocena"
                });
            }
        });
    });

    return results;
}

// parseAttendance - wzorowane na librus-api absence.js (selektor table.center.big.decorated)
function parseAttendance(html) {
    const def = { presence_percentage: 0, unexcused: 0, excused: 0, late: 0 };
    if (!html) return def;

    const $ = cheerio.load(html);
    const bodyText = $("body").text();
    const m = bodyText.match(/(\d+[,.]?\d*)\s*%/);
    const percent = m ? parseFloat(m[1].replace(",", ".")) : 0;

    let unexcused = 0, excused = 0, late = 0;

    // Selektor z librus-api absence.js
    $("table.center.big.decorated tr[class*='line'], table.decorated tr").each((_, row) => {
        $(row).children("td").each((_, cell) => {
            const t = $(cell).text().trim().toLowerCase();
            if (t === "nb" || t === "u") unexcused++;
            else if (t === "nb_u" || t === "uw" || t === "us") excused++;
            else if (t === "sp") late++;
        });
    });

    return { presence_percentage: percent, unexcused, excused, late };
}

// parseTimetable - cheerio z selektorem .text i .classroom z librus-api
function parseTimetable(html) {
    if (!html) return [];
    const $ = cheerio.load(html);
    const lessons = [];
    const days = ["Pn", "Wt", "Śr", "Czw", "Pt"];

    $("table.decorated tbody tr").each((_, row) => {
        const cells = $(row).children("td");
        if (cells.length < 2) return;

        const time = $(cells[0]).text().trim();

        cells.slice(1).each((idx, cell) => {
            if (idx >= 5) return;
            const subject = $(cell).find(".text").first().text().trim();
            const room = $(cell).find(".classroom").first().text().trim();
            if (subject) {
                lessons.push({ day: days[idx], subject, room: room || "-", time });
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
            if (err.message.startsWith("no_session_cookies")) {
                return res.status(401).json({ error: "Nie udało się uzyskać sesji. " + err.message });
            }
            throw err;
        }

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
        console.error("Error:", err.message);
        return res.status(500).json({ error: "Błąd serwera: " + err.message });
    }
});

// Endpoint diagnostyczny - surowy HTML strony ocen
app.post("/debug-html", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) return res.status(400).json({ error: "Brak danych." });
    try {
        const cookies = await loginLibrus(login, pass);
        const html = await fetchPage("/przegladaj_oceny/uczen", cookies);
        const $ = cheerio.load(html);
        return res.json({
            html_length: html.length,
            tables_count: $("table").length,
            decorated_tables: $("table.decorated").length,
            first_table_rows: $("table.decorated").first().find("tr").length,
            second_table_rows: $($("table.decorated")[1]).find("tr").length,
            has_a_title: $("a[title]").length,
            sample_link: $("a[title]").first().attr("title"),
            sample_grade: $("a[title]").first().text().trim(),
            excerpt: html.substring(0, 3000)
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// Endpoint debug OAuth
app.post("/debug-login", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) return res.status(400).json({ error: "Brak danych." });
    const debug = {};
    try {
        const step1 = await httpsRequest({ hostname: "api.librus.pl", path: "/OAuth/Authorization?client_id=46&response_type=code&scope=mydata", method: "GET" }, null, {}, "https://portal.librus.pl/rodzina/synergia/loguj");
        debug.step1 = { status: step1.status, cookies: step1.cookies };

        const formData = `action=login&login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`;
        const step2 = await httpsRequest({ hostname: "api.librus.pl", path: "/OAuth/Authorization/Grant?client_id=46", method: "POST" }, formData, step1.cookies, "https://api.librus.pl/OAuth/Authorization?client_id=46&response_type=code&scope=mydata");
        debug.step2 = { status: step2.status, cookies: step2.cookies, location: step2.location, body: step2.body.substring(0, 300) };

        return res.json(debug);
    } catch (err) {
        return res.status(500).json({ error: err.message, debug });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Librus OAuth Proxy running on port ${PORT}`));
