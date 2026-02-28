/**
 * routes/librus.js
 * 
 * Express route handler dla endpointu /librus.
 * 
 * Łączy auth.js i librusApi.js w jeden flow:
 *   POST /librus {login, pass} → uwierzytelnienie → pobr. danych → JSON response
 * 
 * Obsługa błędów:
 *  - 400: brakujące dane logowania
 *  - 401: błędne dane logowania (INVALID_CREDENTIALS)
 *  - 500: nieoczekiwany błąd serwera
 */
"use strict";

const { Router } = require("express");
const { createClient } = require("../src/createClient");
const { authenticate } = require("../src/auth");
const { getGrades, getAttendance, getTimetable, getLuckyNumber, getMe } = require("../src/librusApi");

const router = Router();

/**
 * POST /librus
 * Body: { login: string, pass: string }
 * 
 * Zwraca: { status: "success", data: { grades, attendance, timetable, luckyNumber, user } }
 */
router.post("/", async (req, res) => {
    const { login, pass } = req.body;

    if (!login || !pass) {
        return res.status(400).json({ error: "Brak danych logowania (login, pass)." });
    }

    // Każde żądanie dostaje własny client z czystym CookieJar
    const client = createClient();

    try {
        // Uwierzytelnij przez OAuth flow (5 kroków)
        await authenticate(client, login, pass);
    } catch (err) {
        if (err.message === "INVALID_CREDENTIALS") {
            return res.status(401).json({ error: "Nieprawidłowy login lub hasło Librusa." });
        }
        console.error("[Route /librus] Auth error:", err.message);
        return res.status(500).json({ error: "Błąd uwierzytelniania: " + err.message });
    }

    // Pobierz wszystkie dane równolegle (szybciej niż sekwencyjnie)
    const [grades, attendance, timetable, luckyNumber, user] = await Promise.allSettled([
        getGrades(client),
        getAttendance(client),
        getTimetable(client),
        getLuckyNumber(client),
        getMe(client),
    ]);

    return res.json({
        status: "success",
        data: {
            grades: grades.status === "fulfilled" ? grades.value.grades : [],
            debug_standard: grades.status === "fulfilled" ? grades.value.debug_standard : null,
            debug_text: grades.status === "fulfilled" ? grades.value.debug_text : null,
            debug_descriptive: grades.status === "fulfilled" ? grades.value.debug_descriptive : null,
            debug_html_dump: grades.status === "fulfilled" ? grades.value.debug_html_dump : null,
            attendance: attendance.status === "fulfilled" ? attendance.value : { summary: {}, records: [] },
            timetable: timetable.status === "fulfilled" ? timetable.value : null,
            luckyNumber: luckyNumber.status === "fulfilled" ? luckyNumber.value : null,
            user: user.status === "fulfilled" ? user.value : null,
        },
    });
});

module.exports = router;
