/**
 * librusApi.js
 * 
 * Wszystkie wywołania REST API Librus Synergia.
 * Bazowy URL: https://synergia.librus.pl/gateway/api/2.0
 * 
 * WAŻNA UWAGA o strukturze danych:
 * Endpoints /Grades i /Attendances zwracają TYLKO referencje przez ID:
 *   - grade.Subject = {Id: 42}  (nie nazwa!)
 *   - grade.Category = {Id: 7}  (nie nazwa!)
 * Dlatego trzeba równolegle pobrać /Subjects i /Grades/Categories
 * i połączyć dane (tzw. "resolve IDs").
 * 
 * Wzorowane na: kbaraniak/librus-api-rewrited
 */
"use strict";

const { GATEWAY_BASE } = require("./auth");

/**
 * Pobiera zasób z gateway API.
 * Zwraca null zamiast rzucać błąd gdy szkoła nie wspiera endpointu.
 * 
 * @param {import("axios").AxiosInstance} client
 * @param {string} path - ścieżka bez base URL, np. "/Grades"
 * @returns {Promise<object|null>}
 */
async function fetchResource(client, path) {
    try {
        const response = await client.get(`${GATEWAY_BASE}${path}`);
        return response.data;
    } catch (err) {
        const status = err.response?.status;
        console.warn(`[LibrusAPI] ${path} -> ${status || err.message}`);
        return null;
    }
}

/**
 * Buduje mapę {Id -> Nazwa} z listy zasobów.
 * Używane do rozwiązywania referencji ID w ocenach i frekwencji.
 * 
 * @param {Array} items - lista obiektów z polem Id i Name/Short
 * @returns {Object} mapa {id: name}
 */
function buildIdMap(items = []) {
    const map = {};
    for (const item of items) {
        if (item?.Id !== undefined) {
            map[item.Id] = item.Name || item.Short || item.Value || String(item.Id);
        }
    }
    return map;
}

/**
 * Pobiera i przetwarza oceny. 
 * 
 * Pobiera równolegle: /Grades, /Subjects, /Grades/Categories
 * Łączy ID z nazwami żeby UI dostał czytelne dane.
 * 
 * @param {import("axios").AxiosInstance} client
 * @returns {Promise<Array>} Lista ocen [{subject, grade, category, weight, date, teacher}]
 */
async function getGrades(client) {
    // Równolegle pobieramy wszystkie potrzebne dane, dodając obsługę Ocen Punktowych i Tekstowych z API
    const [
        gradesData, subjectsData, categoriesData,
        pointGradesData, pointCategoriesData,
        textGradesData, descriptiveGradesData
    ] = await Promise.all([
        fetchResource(client, "/Grades"),
        fetchResource(client, "/Subjects"),
        fetchResource(client, "/Grades/Categories"),
        fetchResource(client, "/PointGrades"),
        fetchResource(client, "/PointGrades/Categories"),
        fetchResource(client, "/TextGrades"),
        fetchResource(client, "/DescriptiveGrades")
    ]);

    // Buduj mapy ID -> Nazwa
    const subjectMap = buildIdMap(subjectsData?.Subjects || []);
    const categoryMap = buildIdMap(categoriesData?.Categories || []);
    const pointCategoryMap = buildIdMap(pointCategoriesData?.Categories || pointCategoriesData?.PointGradesCategories || []);

    // 1. Zwykłe oceny (oraz oceny roczne/śródroczne w systemie punktowym)
    const standardGrades = (gradesData?.Grades || []).map((g) => ({
        subject: subjectMap[g.Subject?.Id] || `Przedmiot #${g.Subject?.Id}`,
        grade: g.Grade,
        category: categoryMap[g.Category?.Id] || `Kategoria #${g.Category?.Id}`,
        weight: g.Weight ?? 1,
        date: g.Date,
        semester: g.Semester,
        isConstituent: g.IsConstituent ?? false,
        isSemestral: g.IsSemestral ?? false,
        type: 'standard'
    }));

    // 2. Oceny w systemie punktowym przez REST API (czasem to działa)
    const pointGrades = (pointGradesData?.PointGrades || []).map((g) => {
        const studentPts = g.StudentPoints || 0;
        const maxPts = g.MaxPoints || 0;
        return {
            subject: subjectMap[g.Subject?.Id] || `Przedmiot #${g.Subject?.Id}`,
            grade: `${studentPts}/${maxPts}`,
            category: pointCategoryMap[g.Category?.Id] || `Kategoria #${g.Category?.Id}`,
            weight: g.Weight ?? 1,
            date: g.Date,
            semester: g.Semester,
            points: studentPts,
            maxPoints: maxPts,
            isConstituent: true,
            isSemestral: false,
            type: 'point_api'
        };
    });

    // 3. HYBRYDOWY SCRAPER HTML dla "Ocen Punktowych" na wypadek twardej blokady po stronie nowej bramki API (TEB Edukacja)
    let extraHtmlPointGrades = [];
    try {
        const cheerio = require('cheerio');
        // Portal ukrył dedykowaną podstronę - ułamki renderowane są obok zwykłych ocen
        const pointHtmlResponse = await client.get('https://synergia.librus.pl/przegladaj_oceny/uczen');
        const $ = cheerio.load(pointHtmlResponse.data);

        // Zwykle w Librus oceny to tabele, przedmioty sa w 2 komórce tr.line0, tr.line1
        $('table tr').each((i, row) => {
            // Szukamy a w class="grade-box" 
            $(row).find('.grade-box a').each((_, aTag) => {
                const gradeText = $(aTag).text().trim(); // Np. 10/10
                if (gradeText && gradeText.includes('/')) {

                    // Bezpieczne znajdowanie przedmiotu - pierwszy nie-linkowy td zawierający tekst
                    let possibleSubject = '';
                    $(row).find('td').each((j, td) => {
                        const txt = $(td).text().trim();
                        if (txt.length > 3 && $(td).find('a').length === 0 && !possibleSubject) {
                            possibleSubject = txt;
                        }
                    });

                    if (possibleSubject) {
                        const rawTitle = $(aTag).attr('title') || 'Wpis punktowy';

                        // Wyciągnij kategorię z "Kategoria: Test<br>Data: ..."
                        let cat = 'Wpis punktowy';
                        if (rawTitle.includes('Kategoria:')) {
                            cat = rawTitle.split('Kategoria:')[1].split('<br')[0].trim();
                        }

                        // Wyciągnij datę: "Data: 2025-10-16"
                        const dateMatch = rawTitle.match(/Data:\s*(\d{4}-\d{2}-\d{2})/);
                        const gradeDate = dateMatch ? dateMatch[1] : null;

                        // Semestr: styczeń-czerwiec = 2, wrzesień-grudzień = 1
                        let semester = 1;
                        if (gradeDate) {
                            const month = parseInt(gradeDate.split('-')[1]);
                            semester = month >= 1 && month <= 6 ? 2 : 1;
                        }

                        extraHtmlPointGrades.push({
                            subject: possibleSubject,
                            grade: gradeText,
                            category: cat,
                            weight: 1,
                            date: gradeDate,
                            semester,
                            type: 'point_html_scraped'
                        });
                    }
                }
            });
        });
    } catch (err) {
        console.error("HTML Scraping failed:", err.message);
    }

    // Sklejamy wszystkie tablice w jedną listę wszystkich wpisów.
    const allGrades = [...standardGrades, ...pointGrades, ...extraHtmlPointGrades];

    // Usuwamy duplikaty systemowe (żeby HTML scraper nie powielał tego samego co REST)
    const uniqueGrades = [];
    const gradeIds = new Set();

    allGrades.forEach(g => {
        // Identyfikator w postaci klucza z przedmiotu i nazwy - system dba o duble
        const uniqStr = `${g.subject}-${g.grade}-${g.category}`;
        if (!gradeIds.has(uniqStr)) {
            uniqueGrades.push(g);
            gradeIds.add(uniqStr);
        }
    });

    return {
        grades: uniqueGrades,
        debug_standard: gradesData?.Grades || [],
        debug_point: pointGradesData?.PointGrades || [],
        debug_text: textGradesData || null,
        debug_descriptive: descriptiveGradesData || null
    };
}

/**
 * Pobiera i przetwarza frekwencję.
 * 
 * Pobiera równolegle: /Attendances, /Attendances/Types
 * Łączy typy nieobecności z ich nazwami.
 * 
 * @param {import("axios").AxiosInstance} client
 * @returns {Promise<Object>} Podsumowanie frekwencji
 */
async function getAttendance(client) {
    const [attendancesData, typesData] = await Promise.all([
        fetchResource(client, "/Attendances"),
        fetchResource(client, "/Attendances/Types"),
    ]);

    if (!attendancesData?.Attendances) {
        return { summary: {}, records: [] };
    }

    const typeMap = buildIdMap(typesData?.Types || []);
    const summary = {};

    const records = attendancesData.Attendances.map((a) => {
        const typeName = typeMap[a.Type?.Id] || "Nieznany";
        // Zlicz per typ
        summary[typeName] = (summary[typeName] || 0) + 1;
        return {
            type: typeName,
            typeId: a.Type?.Id,
            date: a.Date,
            lessonNo: a.LessonNo,
        };
    });

    return { summary, records };
}

/**
 * Pobiera plan lekcji przez scraping HTML strony Librusa.
 * 
 * Zamiast REST API (które nie zwraca nazw sal), scrapeujemy
 * https://synergia.librus.pl/przegladaj_plan_lekcji
 * 
 * HTML zawiera: numery lekcji, godziny, nazwy sal (s. 226), nauczyciela
 * Format komórki: "Przedmiot\n-Nauczyciel s. 226"
 * 
 * @param {import("axios").AxiosInstance} client - pełny klient z cookies Librusa
 * @returns {Promise<Object>} { "2026-03-02": [{lessonNo, time, subject, teacher, room}] }
 */
async function getTimetable(client) {
    const cheerio = require('cheerio');
    const result = {};

    try {
        const resp = await client.get('https://synergia.librus.pl/przegladaj_plan_lekcji');
        const $ = cheerio.load(resp.data);

        // Tabela planu ma nagłówki z datami (Poniedziałek 2026-03-02 itd.)
        // Pierwsza kolumna = Nr lekcji, druga = Godziny, potem Pon-Pt, Sob, Nd
        const dateMap = {}; // kolumna_index -> "2026-03-02"

        // Szukamy nagłówków kolumn - zawierają datę w formacie YYYY-MM-DD lub tekst "Poniedziałek 2026-03-02"
        $('table.decorated thead tr').first().find('th').each((colIdx, th) => {
            const txt = $(th).text().trim();
            // Szukamy daty YYYY-MM-DD lub słów Poniedziałek/Wtorek/... + daty
            const dateMatch = txt.match(/(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
                dateMap[colIdx] = dateMatch[1];
                result[dateMatch[1]] = [];
            }
        });

        // Jeśli nie znaleźliśmy dat w nagłówku, spróbuj alternatywnego selektora
        if (Object.keys(dateMap).length === 0) {
            $('table.decorated tr').first().find('td, th').each((colIdx, cell) => {
                const txt = $(cell).text().trim();
                const dateMatch = txt.match(/(\d{4}-\d{2}-\d{2})/);
                if (dateMatch) {
                    dateMap[colIdx] = dateMatch[1];
                    result[dateMatch[1]] = [];
                }
            });
        }

        // Godziny lekcji - szukamy w wierszach
        const lessonTimes = {}; // lessonNo -> "08:00-08:45"

        // Parsuj wiersze lekcji
        $('table.decorated tbody tr, table.decorated tr').each((rowIdx, row) => {
            const cells = $(row).find('td');
            if (cells.length < 3) return;

            // Kolumna 0: numer lekcji (0-12)
            const lessonNoText = $(cells[0]).text().trim();
            const lessonNo = parseInt(lessonNoText);
            if (isNaN(lessonNo)) return;

            // Kolumna 1: godziny (08:00 - 08:45 lub 08:00\n08:45)
            const timeText = $(cells[1]).text().replace(/\s+/g, ' ').trim();
            const timeMatch = timeText.match(/(\d{2}:\d{2})[^\d]+(\d{2}:\d{2})/);
            const timeStr = timeMatch ? `${timeMatch[1]} – ${timeMatch[2]}` : timeText;

            // Kolumny 2+: przedmioty per dzień
            cells.each((cellIdx, cell) => {
                if (cellIdx < 2) return; // Pomiń nr lekcji i godziny

                const dateKey = dateMap[cellIdx];
                if (!dateKey) return;

                // Szukaj bloków lekcji (może być kilka grup w jednej komórce)
                const cellHtml = $(cell).html() || '';
                const cellText = $(cell).text().trim();
                if (!cellText) return;

                // Format: "Przedmiot\n-Nauczyciel s. Sala" lub divki
                // Próbuj parsować każdy blok (gdy są dwie grupy, dzielone przez <br> lub div)
                const blocks = [];

                // Szukaj divów lub paragrafów z lekcjami
                const innerDivs = $(cell).find('div, p');
                if (innerDivs.length > 0) {
                    innerDivs.each((_, div) => {
                        const text = $(div).text().trim();
                        if (text.length > 3) blocks.push(text);
                    });
                } else {
                    // Podziel po <br> lub po znaku nowej linii
                    const lines = cellText.split(/\n/).map(l => l.trim()).filter(Boolean);
                    if (lines.length >= 1) blocks.push(lines.join('\n'));
                }

                // Parsuj każdy blok: "Przedmiot\n-Nauczyciel s. 226"
                for (const block of blocks) {
                    if (!block || block.length < 3) continue;

                    const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
                    const subject = lines[0] || '';
                    let teacher = '';
                    let room = '';

                    // Linia nauczyciel+sala: "-Mika Mariusz s. 210" lub "Mika Mariusz s. 210"
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].replace(/^-/, '').trim();
                        const roomMatch = line.match(/^(.+?)\s+s\.\s+(\S+)/);
                        if (roomMatch) {
                            teacher = roomMatch[1].trim();
                            room = `s. ${roomMatch[2]}`;
                        } else if (line.length > 2) {
                            teacher = line;
                        }
                    }

                    if (subject) {
                        if (!result[dateKey]) result[dateKey] = [];
                        result[dateKey].push({
                            lessonNo,
                            time: timeStr,
                            subject,
                            teacher,
                            room,
                            isCancelled: false,
                            isSubstitution: false,
                        });
                    }
                }
            });
        });

        // Posortuj lekcje w każdym dniu po numerze lekcji
        for (const dateKey of Object.keys(result)) {
            result[dateKey].sort((a, b) => a.lessonNo - b.lessonNo);
        }

    } catch (err) {
        console.error('[getTimetable HTML] Scraping failed:', err.message);
    }

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Pobiera szczęśliwy numer z Librusa.
 * 
 * @param {import("axios").AxiosInstance} client
 * @returns {Promise<number|null>}
 */
async function getLuckyNumber(client) {
    const data = await fetchResource(client, "/LuckyNumbers");
    return data?.LuckyNumber?.LuckyNumber ?? null;
}

/**
 * Pobiera informacje o zalogowanym użytkowniku.
 * 
 * @param {import("axios").AxiosInstance} client
 * @returns {Promise<Object|null>}
 */
async function getMe(client) {
    const data = await fetchResource(client, "/Me");
    return data?.Me || null;
}

module.exports = {
    getGrades,
    getAttendance,
    getTimetable,
    getLuckyNumber,
    getMe,
    fetchResource, // eksportujemy żeby można było dodawać nowe endpointy bez modyfikacji tego pliku
};
