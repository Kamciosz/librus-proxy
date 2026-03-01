const { createClient } = require("./src/createClient");
const { authenticate } = require("./src/auth");

async function test() {
    console.log("Starting test...");
    const client = createClient();
    await authenticate(client, "12194674u", "kamciosz12%Pusia");
    console.log("Authenticated!");

    const cheerio = require('cheerio');
    console.log("Fetching timetable HTML...");
    const resp = await client.get('https://synergia.librus.pl/przegladaj_plan_lekcji');
    const html = resp.data;
    console.log("Got HTML:", html.length, "bytes");

    const $ = cheerio.load(html);
    const result = {};

    const dateMap = {}; 
    $('table.decorated thead tr').first().find('th').each((colIdx, th) => {
        const txt = $(th).text().trim();
        const dateMatch = txt.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            dateMap[colIdx] = dateMatch[1];
            result[dateMatch[1]] = [];
            console.log("Found date in thead:", dateMatch[1], "col:", colIdx);
        }
    });

    if (Object.keys(dateMap).length === 0) {
        console.log("Dates not found in thead, trying general table trace...");
        $('table.decorated tr').first().find('td, th').each((colIdx, cell) => {
            const txt = $(cell).text().trim();
            console.log(`Cell ${colIdx}:`, txt);
            const dateMatch = txt.match(/(\d{4}-\d{2}-\d{2})/);
            if (dateMatch) {
                dateMap[colIdx] = dateMatch[1];
                result[dateMatch[1]] = [];
                console.log("Found date in first row:", dateMatch[1], "col:", colIdx);
            }
        });
    }

    $('table.decorated tbody tr, table.decorated tr').each((rowIdx, row) => {
        const cells = $(row).find('td');
        if (cells.length < 3) return;

        const lessonNoText = $(cells[0]).text().trim();
        const lessonNo = parseInt(lessonNoText);
        if (isNaN(lessonNo)) return;

        console.log("Parsing row for lesson:", lessonNo);
        // rest of implementation could be checked here...
    });
    
    console.log("Found days:", Object.keys(dateMap));
    console.log("dateMap:", dateMap);
}

test().catch(console.error);
