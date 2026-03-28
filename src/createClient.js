/**
 * createClient.js
 *
 * Tworzy klienta HTTP opartego na axios z automatycznym zarzadzaniem cookies.
 * Wzorowane na kbaraniak/librus-api-rewrited (api.js).
 *
 * got-scraping zostal przetestowany ale psuje sesje OAuth Librusa — jego
 * wbudowany generator naglowkow TLS zmienia User-Agent i sec-fetch-* miedzy
 * zadaniami, co sprawia ze serwer Librusa odrzuca pozniejsze kroki flow.
 */

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function createClient() {
    const jar = new CookieJar();

    // Obsluga zewnetrznego proxy (np. Residential Proxy)
    let httpsAgent = undefined;
    if (process.env.LIBRUS_PROXY_URL) {
        httpsAgent = new HttpsProxyAgent(process.env.LIBRUS_PROXY_URL);
    }

    const client = wrapper(axios.create({
        jar,
        timeout: 60000, // 60s — wczesniej brak timeout powodowal wisenie na Railway
        httpsAgent,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/html, */*',
            'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
            // identity zapobiega gzip — prostsze parsowanie odpowiedzi
            'Accept-Encoding': 'identity',
            // Referer wymagany od Nov 2025 (PR #81 Mati365/librus-api)
            'Referer': 'https://portal.librus.pl/rodzina/synergia/loguj',
        },
        maxRedirects: 5,
    }));

    return client;
}
