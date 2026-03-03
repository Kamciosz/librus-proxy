/**
 * librusApi.js
 * 
 * Wszystkie wywołania REST API Librus Synergia.
 */

import { GATEWAY_BASE } from "./auth.js";
import * as cheerio from 'cheerio';

/**
 * Pobiera zasób z gateway API.
 * 
 * @param {import("axios").AxiosInstance} client
 * @param {string} path - ścieżka bez base URL, np. "/Grades"
 * @returns {Promise<object|null>}
 */
export async function fetchResource(client, path) {
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
 */
export async function getGrades(client) {
    // Równolegle pobieramy wszystkie potrzebne dane
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

    // 2. Oceny w systemie punktowym przez REST API
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

    // 3. HYBRYDOWY SCRAPER HTML dla "Ocen Punktowych"
    let extraHtmlPointGrades = [];
    try {
        const pointHtmlResponse = await client.get('https://synergia.librus.pl/przegladaj_oceny/uczen');
        const $ = cheerio.load(pointHtmlResponse.data);

        $('table tr').each((i, row) => {
            $(row).find('.grade-box a').each((_, aTag) => {
                const gradeText = $(aTag).text().trim(); // Np. 10/10
                if (gradeText && gradeText.includes('/')) {
                    let possibleSubject = '';
                    $(row).find('td').each((j, td) => {
                        const txt = $(td).text().trim();
                        if (txt.length > 3 && $(td).find('a').length === 0 && !possibleSubject) {
                            possibleSubject = txt;
                        }
                    });

                    if (possibleSubject) {
                        const rawTitle = $(aTag).attr('title') || 'Wpis punktowy';
                        let cat = 'Wpis punktowy';
                        if (rawTitle.includes('Kategoria:')) {
                            cat = rawTitle.split('Kategoria:')[1].split('<br')[0].trim();
                        }
                        const dateMatch = rawTitle.match(/Data:\s*(\d{4}-\d{2}-\d{2})/);
                        const gradeDate = dateMatch ? dateMatch[1] : null;

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

    const allGrades = [...standardGrades, ...pointGrades, ...extraHtmlPointGrades];

    const uniqueGrades = [];
    const gradeIds = new Set();

    allGrades.forEach(g => {
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
 */
export async function getAttendance(client) {
    const [attendancesData, typesData, subjectsData, lessonsData] = await Promise.all([
        fetchResource(client, "/Attendances"),
        fetchResource(client, "/Attendances/Types"),
        fetchResource(client, "/Subjects"),
        fetchResource(client, "/Lessons"),
    ]);

    if (!attendancesData?.Attendances) {
        return { summary: {}, records: [] };
    }

    const typeMap = buildIdMap(typesData?.Types || []);
    const subjectMap = buildIdMap(subjectsData?.Subjects || []);

    const lessonMap = {};
    (lessonsData?.Lessons || []).forEach(l => {
        if (l.Id && l.Subject?.Id) {
            lessonMap[l.Id] = l.Subject.Id;
        }
    });

    const summary = {};

    const records = attendancesData.Attendances.map((a) => {
        const typeName = typeMap[a.Type?.Id] || "Nieznany";
        const subjectId = (a.Lesson?.Id ? lessonMap[a.Lesson.Id] : null) || a.Subject?.Id;
        const subjectName = subjectId ? (subjectMap[subjectId] || "Nieznany") : "Inne";

        summary[typeName] = (summary[typeName] || 0) + 1;

        return {
            type: typeName,
            typeId: a.Type?.Id,
            date: a.Date,
            lessonNo: a.LessonNo,
            subject: subjectName,
            semester: a.Semester,
            _raw: a
        };
    });

    return { summary, records };
}

/**
 * Pobiera plan lekcji z uwzględnieniem danego tygodnia i mapuje sale/nauczycieli.
 */
export async function getTimetable(client, weekStart) {
    const timetableUrl = weekStart ? `/Timetables?weekStart=${weekStart}` : "/Timetables";

    const [timetableData, classroomsData] = await Promise.all([
        fetchResource(client, timetableUrl),
        fetchResource(client, "/Classrooms")
    ]);

    if (!timetableData?.Timetable) return null;

    const classroomMap = buildIdMap(classroomsData?.Classrooms || []);
    const result = {};

    for (const [dateKey, daySlots] of Object.entries(timetableData.Timetable)) {
        result[dateKey] = [];
        if (!Array.isArray(daySlots)) continue;

        for (const slotGroup of daySlots) {
            if (!Array.isArray(slotGroup) || slotGroup.length === 0) continue;

            for (const lesson of slotGroup) {
                if (!lesson.Subject) continue;

                const teacherName = lesson.Teacher
                    ? `${lesson.Teacher.FirstName || ''} ${lesson.Teacher.LastName || ''}`.trim()
                    : '';

                let roomName = '';
                if (lesson.Classroom?.Id) {
                    const rawRoom = classroomMap[lesson.Classroom.Id] || lesson.Classroom.Id;
                    roomName = `s. ${rawRoom}`;
                }

                result[dateKey].push({
                    lessonNo: lesson.LessonNo || parseInt(lesson.LessonNo) || 0,
                    time: `${lesson.HourFrom || '?'} – ${lesson.HourTo || '?'}`,
                    subject: lesson.Subject.Name || lesson.Subject.Short || '',
                    teacher: teacherName,
                    room: roomName,
                    isCancelled: lesson.IsCanceled || lesson.IsCancelled || false,
                    isSubstitution: lesson.IsSubstitutionClass || lesson.IsSubstitution || false
                });
            }
        }
    }

    for (const dateKey of Object.keys(result)) {
        result[dateKey].sort((a, b) => parseInt(a.lessonNo) - parseInt(b.lessonNo));
    }

    return result;
}

/**
 * Pobiera szczęśliwy numer z Librusa.
 */
export async function getLuckyNumber(client) {
    const data = await fetchResource(client, "/LuckyNumbers");
    return data?.LuckyNumber?.LuckyNumber ?? null;
}

/**
 * Pobiera informacje o zalogowanym użytkowniku.
 */
export async function getMe(client) {
    const data = await fetchResource(client, "/Me");
    return data?.Me || null;
}
