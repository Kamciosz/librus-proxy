"use strict";
const express = require("express");
const cors = require("cors");
const https = require("https");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Helper: execute HTTPS request with cookies
function httpsRequest(options, body, cookies) {
    return new Promise((resolve, reject) => {
        const cookieStr = Object.entries(cookies || {})
            .map(([k, v]) => `${k}=${v}`).join("; ");

        const reqOptions = {
            ...options,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT x.y; Win64; x64; rv:10.0) Gecko/20100101 Firefox/10.0",
                "Content-Type": "application/x-www-form-urlencoded",
                "Cookie": cookieStr,
                ...(options.headers || {})
            }
        };

        const req = https.request(reqOptions, (res) => {
            let data = "";
            const setCookies = {};
            (res.headers["set-cookie"] || []).forEach(c => {
                const [kv] = c.split(";");
                const [k, v] = kv.split("=");
                if (k && v !== undefined) setCookies[k.trim()] = v.trim();
            });
            res.on("data", chunk => data += chunk);
            res.on("end", () => resolve({
                status: res.statusCode,
                headers: res.headers,
                cookies: setCookies,
                body: data,
                location: res.headers["location"] || ""
            }));
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// Logowanie OAuth: GET Authorization → POST Grant → ciasteczka sesji
async function loginLibrus(login, pass) {
    let sessionCookies = {};

    // KROK 1: GET Authorization page - zdobądź ciasteczka i CSRF
    const step1 = await httpsRequest({
        hostname: "api.librus.pl",
        path: "/OAuth/Authorization?client_id=46&response_type=code&scope=mydata",
        method: "GET"
    }, null, {});

    Object.assign(sessionCookies, step1.cookies);

    // KROK 2: POST Grant - zaloguj się
    const formData = `action=login&login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`;

    const step2 = await httpsRequest({
        hostname: "api.librus.pl",
        path: "/OAuth/Authorization/Grant?client_id=46",
        method: "POST",
        headers: {
            "Content-Length": Buffer.byteLength(formData),
            "Referer": "https://api.librus.pl/OAuth/Authorization?client_id=46"
        }
    }, formData, sessionCookies);

    Object.assign(sessionCookies, step2.cookies);

    // Sprawdź czy zalogowanie się powiodło (powinno zwrócić redirect z kodem)
    if (step2.status !== 302 && step2.status !== 200) {
        throw new Error(`auth_failed:${step2.status}`);
    }

    // Sprawdź czy body zawiera błąd
    if (step2.body && (
        step2.body.includes("Błędny login lub hasło") ||
        step2.body.includes("error") && step2.body.includes("invalid")
    )) {
        throw new Error("invalid_credentials");
    }

    // KROK 3: Pobierz redirect URL z kodu autoryzacji i zdobądź ciasteczka Synergii
    const redirectUrl = step2.location || step2.headers?.["location"] || "";
    if (redirectUrl && redirectUrl.includes("?code=")) {
        const url = new URL(redirectUrl.startsWith("http") ? redirectUrl : `https://synergia.librus.pl${redirectUrl}`);
        const step3 = await httpsRequest({
            hostname: "synergia.librus.pl",
            path: url.pathname + url.search,
            method: "GET"
        }, null, sessionCookies);
        Object.assign(sessionCookies, step3.cookies);
    }

    // Sprawdź czy mamy ciasteczka sesji Synergii
    if (!sessionCookies["DZIENNIKSID"] && !sessionCookies["SDZIENNIKSID"]) {
        // Spróbuj bezpośrednio strony Synergii
        const directLogin = await httpsRequest({
            hostname: "synergia.librus.pl",
            path: "/loguj",
            method: "POST",
            headers: { "Content-Length": Buffer.byteLength(`login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`) }
        }, `login=${encodeURIComponent(login)}&pass=${encodeURIComponent(pass)}`, sessionCookies);
        Object.assign(sessionCookies, directLogin.cookies);
    }

    return sessionCookies;
}

// Pobieranie strony z sesją Synergii 
async function fetchSynergiaPage(path, cookies) {
    const response = await httpsRequest({
        hostname: "synergia.librus.pl",
        path: path,
        method: "GET"
    }, null, cookies);

    if (response.status === 302) {
        // Nieautoryzowany - sesja wygasła
        throw new Error("session_expired");
    }

    return response.body;
}

// Parsowanie ocen z HTML
function parseGrades(html) {
    const grades = [];
    if (!html) return grades;

    // Tabela z klasą "decorated" zawiera oceny  
    const tableMatch = html.match(/<table[^>]*class="[^"]*decorated[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
    if (!tableMatch) return grades;

    const tbody = tableMatch[1];
    const rows = tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];

    rows.forEach(row => {
        const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
        if (cells.length < 2) return;

        const subject = cells[0].replace(/<[^>]+>/g, "").trim();
        if (!subject || subject.length < 2) return;

        // Poszukaj linków z ocenami (class="grade-box" lub tytuł w title=)
        const gradeLinks = row.match(/<a[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/gi) || [];
        gradeLinks.forEach(link => {
            const titleMatch = link.match(/title="([^"]*)"/);
            const gradeMatch = link.match(/>([^<]+)<\/a>/);
            const grade = gradeMatch?.[1]?.trim();
            const desc = titleMatch?.[1]?.split(";")?.[0]?.trim() || "Ocena";
            if (grade && grade.length > 0 && grade !== " ") {
                grades.push({ subject, grade, desc });
            }
        });
    });

    return grades;
}

// Parsowanie frekwencji z HTML
function parseAttendance(html) {
    if (!html) return { presence_percentage: 0, unexcused: 0, excused: 0, late: 0 };

    const percentMatch = html.match(/(\d+[,.]?\d*)\s*%/);
    const percent = percentMatch ? parseFloat(percentMatch[1].replace(",", ".")) : 0;

    let unexcused = 0, excused = 0, late = 0;
    const cells = html.match(/<td[^>]*>([^<]*)<\/td>/gi) || [];
    cells.forEach(cell => {
        const t = cell.replace(/<[^>]+>/g, "").trim().toLowerCase();
        if (t === "nb" || t === "u") unexcused++;
        else if (t === "nb_u" || t === "us" || t === "uw") excused++;
        else if (t === "sp") late++;
    });

    return { presence_percentage: percent, unexcused, excused, late };
}

// Parsowanie planu lekcji z HTML
function parseTimetable(html) {
    if (!html) return [];
    const lessons = [];
    const days = ["Pn", "Wt", "Śr", "Czw", "Pt"];

    const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    rows.forEach(row => {
        const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
        if (cells.length < 2) return;

        const timeCell = cells[0].replace(/<[^>]+>/g, "").trim();

        cells.slice(1).forEach((cell, idx) => {
            // Szukaj tekstu lekcji - zazwyczaj w divie
            const textMatch = cell.match(/class="text"[^>]*>([^<]+)/i) ||
                cell.match(/class="lesson"[^>]*>([^<]+)/i);
            const roomMatch = cell.match(/class="classroom"[^>]*>([^<]+)/i) ||
                cell.match(/class="room"[^>]*>([^<]+)/i);

            const subject = textMatch?.[1]?.trim();
            const room = roomMatch?.[1]?.trim() || "-";

            if (subject && idx < 5) {
                lessons.push({
                    day: days[idx],
                    subject,
                    room,
                    time: timeCell
                });
            }
        });
    });

    return lessons;
}

// Weryfikacja sesji po logowaniu
async function verifySession(cookies) {
    try {
        const html = await fetchSynergiaPage("/uczen/index", cookies);
        // Sprawdź czy strona zawiera elementy logowanego użytkownika
        return !html.includes("loguj") && html.length > 1000;
    } catch {
        return false;
    }
}

app.post("/librus", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass) return res.status(400).json({ error: "Brak danych logowania." });

    try {
        // Zaloguj się przez OAuth API
        let sessionCookies;
        try {
            sessionCookies = await loginLibrus(login, pass);
        } catch (err) {
            if (err.message.includes("invalid_credentials") || err.message.includes("auth_failed")) {
                return res.status(401).json({ error: "Nieprawidłowy login lub hasło Synergia." });
            }
            throw err;
        }

        // Zweryfikuj sesję
        const isValid = await verifySession(sessionCookies);
        if (!isValid) {
            return res.status(401).json({ error: "Nie udało się zalogować do Synergii. Sprawdź dane." });
        }

        // Pobierz dane równolegle
        const [gradesHtml, attendanceHtml, timetableHtml] = await Promise.allSettled([
            fetchSynergiaPage("/przegladaj_oceny/uczen", sessionCookies),
            fetchSynergiaPage("/przegladaj_nb/uczen", sessionCookies),
            fetchSynergiaPage("/przegladaj_plan_lekcji", sessionCookies)
        ]);

        const grades = gradesHtml.status === "fulfilled" ? parseGrades(gradesHtml.value) : [];
        const attendance = attendanceHtml.status === "fulfilled" ? parseAttendance(attendanceHtml.value) : { presence_percentage: 0 };
        const timetable = timetableHtml.status === "fulfilled" ? parseTimetable(timetableHtml.value) : [];

        return res.json({
            status: "success",
            data: { grades, attendance, timetable }
        });

    } catch (err) {
        console.error("Error:", err.message);
        return res.status(500).json({ error: "Błąd serwera: " + (err.message || "nieznany") });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Librus OAuth Proxy running on port ${PORT}`));
