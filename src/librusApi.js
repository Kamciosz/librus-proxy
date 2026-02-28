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
    // Równolegle pobieramy wszystkie potrzebne dane, dodając obsługę Ocen Punktowych i Tekstowych
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

    // 2. Oceny w systemie punktowym (Librus przechowuje je jako StudentPoints i MaxPoints np. 10/15)
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
            type: 'point'
        };
    });

    // Sklejamy obie tablice w jedną listę wszystkich wpisów.
    return {
        grades: [...standardGrades, ...pointGrades],
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
 * Pobiera plan lekcji na aktualny tydzień.
 * 
 * @param {import("axios").AxiosInstance} client
 * @returns {Promise<Object>} Plan lekcji z API (surowy, do przetwarzania przez frontend)
 */
async function getTimetable(client) {
    const data = await fetchResource(client, "/Timetables");
    return data?.Timetable || null;
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
