"use strict";
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

async function loginToLibrus(browser, login, pass) {
    const context = await browser.newContext({
        userAgent:
            "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
        // Użyj właściwego URL logowania przez portal Librus Rodzina
        await page.goto("https://portal.librus.pl/rodzina/synergia/loguj", {
            waitUntil: "networkidle",
            timeout: 30000,
        });

        // Poczekaj na załadowanie formularza
        await page.waitForSelector('input[id="Login"], input[name="Login"], input[type="text"]', { timeout: 10000 });

        // Wpisz login
        const loginInput = await page.$('input[id="Login"]') ||
            await page.$('input[name="login"]') ||
            await page.$('input[type="text"]');
        if (loginInput) await loginInput.fill(login);

        // Wpisz hasło
        const passInput = await page.$('input[id="Pass"]') ||
            await page.$('input[name="pass"]') ||
            await page.$('input[type="password"]');
        if (passInput) await passInput.fill(pass);

        // Kliknij przycisk zaloguj
        await Promise.all([
            page.waitForNavigation({ timeout: 15000 }).catch(() => { }),
            page.click('button[type="submit"], input[type="submit"], .btn-login, button:has-text("Zaloguj"), button:has-text("ZALOGUJ")'),
        ]);

        // Poczekaj chwilę
        await page.waitForTimeout(2000);

        const url = page.url();
        const content = await page.content();

        // Sprawdź czy logowanie powiodło się
        if (
            content.toLowerCase().includes("błędny") ||
            content.toLowerCase().includes("nieprawidłowy") ||
            content.includes("Podaj login") ||
            url.includes("loguj")
        ) {
            await context.close();
            return null;
        }

        // Jeśli przekierował na stronę Synergii - sukces
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

                // Szukaj linków z ocenami (punktowymi i tradycyjnymi)
                for (let i = 1; i < cells.length; i++) {
                    const anchors = cells[i].querySelectorAll("a");
                    anchors.forEach((a) => {
                        const grade = a.textContent?.trim();
                        if (!grade || grade === "") return;
                        const title = a.getAttribute("title") || "";
                        results.push({
                            subject,
                            grade,
                            desc: title.split(";")[0]?.trim() || "Ocena",
                        });
                    });
                }
            });

            return results;
        });

        return grades;
    } catch (err) {
        console.error("Grades error:", err.message);
        return [];
    }
}

async function getAttendance(page) {
    try {
        await page.goto("https://synergia.librus.pl/przegladaj_nb/uczen", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });

        return await page.evaluate(() => {
            const text = document.body.innerText;
            const percentMatch = text.match(/(\d+[,.]?\d*)\s*%/);
            const percent = percentMatch
                ? parseFloat(percentMatch[1].replace(",", "."))
                : 0;

            let unexcused = 0, excused = 0, late = 0;
            document.querySelectorAll("td").forEach((td) => {
                const t = td.textContent?.trim().toLowerCase();
                if (t === "nb" || t === "u") unexcused++;
                else if (t === "nb_u" || t === "us") excused++;
                else if (t === "sp") late++;
            });

            return { presence_percentage: percent, unexcused, excused, late };
        });
    } catch {
        return { presence_percentage: 0, unexcused: 0, excused: 0, late: 0 };
    }
}

async function getTimetable(page) {
    try {
        await page.goto("https://synergia.librus.pl/przegladaj_plan_lekcji", {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });

        return await page.evaluate(() => {
            const lessons = [];
            const days = ["Pn", "Wt", "Śr", "Czw", "Pt"];

            document.querySelectorAll("table.decorated tbody tr").forEach((row) => {
                const timeCell = row.querySelector("td:first-child");
                const time = timeCell?.textContent?.trim() || "";

                row.querySelectorAll("td:not(:first-child)").forEach((cell, idx) => {
                    const text = cell.querySelector(".text, .lesson-subject")?.textContent?.trim();
                    const room = cell.querySelector(".classroom, .room")?.textContent?.trim();
                    if (text) {
                        lessons.push({
                            day: days[idx] || idx.toString(),
                            subject: text,
                            room: room || "-",
                            time,
                        });
                    }
                });
            });

            return lessons;
        });
    } catch {
        return [];
    }
}

app.post("/librus", async (req, res) => {
    const { login, pass } = req.body;
    if (!login || !pass)
        return res.status(400).json({ error: "Brak danych logowania." });

    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        });

        const session = await loginToLibrus(browser, login, pass);
        if (!session) {
            await browser.close();
            return res.status(401).json({ error: "Nieprawidłowy login lub hasło." });
        }

        const { page } = session;

        const grades = await getGrades(page);
        const attendance = await getAttendance(page);
        const timetable = await getTimetable(page);

        await browser.close();

        return res.json({
            status: "success",
            data: { grades, attendance, timetable },
        });
    } catch (err) {
        if (browser) await browser.close().catch(() => { });
        console.error("Server error:", err.message);
        return res.status(500).json({ error: "Błąd serwera: " + (err.message || "nieznany") });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`Librus Proxy running on port ${PORT}`));
