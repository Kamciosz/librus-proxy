"use strict";
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Cache sesji – każdy zalogowany użytkownik ma swój token (trzymamy max 1h)
const sessionCache = new Map();

async function loginToLibrus(browser, login, pass) {
    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
        // Wejdź na stronę logowania
        await page.goto("https://synergia.librus.pl/loguj", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        // Wpisz dane logowania
        await page.fill('input[name="login"]', login);
        await page.fill('input[name="pass"]', pass);
        await page.click('input[type="submit"], button[type="submit"]');

        // Poczekaj na przekierowanie po zalogowaniu
        await page.waitForNavigation({ timeout: 15000 }).catch(() => { });

        // Sprawdź czy zalogowanie się powiodło
        const url = page.url();
        const content = await page.content();

        if (
            content.includes("Błędny") ||
            content.includes("Podaj login") ||
            url.includes("loguj")
        ) {
            await context.close();
            return null; // błąd logowania
        }

        return { context, page };
    } catch (err) {
        await context.close();
        throw err;
    }
}

async function getGrades(page) {
    try {
        await page.goto("https://synergia.librus.pl/przegladaj_oceny/uczen", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });

        const grades = await page.evaluate(() => {
            const results = [];
            const rows = document.querySelectorAll("table.decorated tbody tr");

            rows.forEach((row) => {
                const cells = row.querySelectorAll("td");
                if (cells.length < 2) return;

                const subject = cells[0]?.textContent?.trim();
                if (!subject || subject === "") return;

                // Zbierz oceny z pozostałych kolumn
                for (let i = 1; i < cells.length; i++) {
                    const gradeAnchors = cells[i].querySelectorAll("a, span.grade-box");
                    gradeAnchors.forEach((el) => {
                        const grade = el.textContent?.trim();
                        if (grade && grade.length > 0 && grade !== "&nbsp;") {
                            const title =
                                el.getAttribute("title") ||
                                el.closest("td")?.querySelector(".tooltip")?.textContent ||
                                "Ocena";
                            results.push({
                                subject,
                                grade,
                                desc: title.split(";")[0]?.trim() || "Ocena",
                            });
                        }
                    });

                    // Jeśli nie ma linków, sprawdź tekst komórki (oceny końcowe)
                    if (gradeAnchors.length === 0) {
                        const text = cells[i].textContent?.trim();
                        const header = document.querySelector(`table.decorated thead th:nth-child(${i + 1})`)?.textContent?.trim();
                        if (text && text !== "" && text !== "-" && header) {
                            results.push({ subject, grade: text, desc: header });
                        }
                    }
                }
            });

            return results;
        });

        return grades;
    } catch (err) {
        console.error("Error getting grades:", err.message);
        return [];
    }
}

async function getAttendance(page) {
    try {
        await page.goto("https://synergia.librus.pl/przegladaj_nb/uczen", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });

        const attendance = await page.evaluate(() => {
            // Szukamy procentu obecności
            const text = document.body.innerText;
            const percentMatch = text.match(/(\d+[,.]?\d*)\s*%/);
            const percent = percentMatch
                ? parseFloat(percentMatch[1].replace(",", "."))
                : 0;

            // Zlicz nieobecności
            const cells = document.querySelectorAll("td.center");
            let unexcused = 0;
            let excused = 0;
            let late = 0;
            cells.forEach((cell) => {
                const abbr = cell.querySelector("abbr");
                const type = abbr?.getAttribute("title") || cell.textContent?.trim();
                if (type.includes("nieusprawiedliwiona") || type === "u" || type === "nb")
                    unexcused++;
                else if (type.includes("usprawiedliwiona") || type === "nb_u") excused++;
                else if (type.includes("spóźnienie") || type === "sp") late++;
            });

            return {
                presence_percentage: percent,
                unexcused,
                excused,
                late,
            };
        });

        return attendance;
    } catch (err) {
        return { presence_percentage: 0, unexcused: 0, excused: 0, late: 0 };
    }
}

async function getTimetable(page) {
    try {
        await page.goto("https://synergia.librus.pl/przegladaj_plan_lekcji", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });

        const timetable = await page.evaluate(() => {
            const lessons = [];
            const rows = document.querySelectorAll("table.grid tbody tr");

            rows.forEach((row) => {
                const timeCell = row.querySelector("td.center");
                const time = timeCell?.textContent?.trim();

                const lessonCells = row.querySelectorAll("td:not(.center)");
                lessonCells.forEach((cell, dayIdx) => {
                    const subject = cell
                        .querySelector(".text")
                        ?.textContent?.trim();
                    const room = cell.querySelector(".classroom")?.textContent?.trim();

                    if (subject) {
                        const days = ["Pn", "Wt", "Śr", "Czw", "Pt"];
                        lessons.push({
                            day: days[dayIdx] || dayIdx.toString(),
                            subject,
                            room: room || "-",
                            time: time || "",
                        });
                    }
                });
            });

            return lessons;
        });

        return timetable;
    } catch (err) {
        return [];
    }
}

// Główny endpoint
app.post("/librus", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass)
        return res.status(400).json({ error: "Brak danych logowania." });

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });

        const session = await loginToLibrus(browser, login, pass);
        if (!session) {
            await browser.close();
            return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
        }

        const { page } = session;

        // Pobierz dane równolegle (sekwencyjnie by nie stracić sesji)
        const grades = await getGrades(page);
        const attendance = await getAttendance(page);
        const timetable = await getTimetable(page);

        await browser.close();

        return res.json({
            status: "success",
            data: { grades, attendance, timetable },
        });
    } catch (err) {
        if (browser) await browser.close();
        console.error("Server error:", err);
        return res
            .status(500)
            .json({ error: "Błąd serwera: " + (err.message || "nieznany") });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Librus Proxy running on port ${PORT}`));
