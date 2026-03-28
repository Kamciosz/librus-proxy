/**
 * createClient.js
 * 
 * Tworzy klienta HTTP opartego na 'got-scraping'.
 * Zastępuje Axios, aby lepiej udawać przeglądarkę (TLS Fingerprinting).
 * To kluczowe, aby uniknąć blokad IP/Botów na Railway.
 */

import { gotScraping } from 'got-scraping';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function createClient() {
    const cookieJar = new CookieJar();
    
    // Obsługa zewnętrznego proxy (np. Residential Proxy)
    let agent = undefined;
    if (process.env.LIBRUS_PROXY_URL) {
        agent = {
            https: new HttpsProxyAgent(process.env.LIBRUS_PROXY_URL)
        };
    }

    // Instancja got-scraping z automatycznym zarządzaniem nagłówkami i TLS.
    // WAŻNE: useHeaderGenerator: false — wyłącza losowe nagłówki per-request.
    // Losowe User-Agent/sec-fetch-* między requestami psuły sesję OAuth Librusa
    // (serwer śledzi nagłówki i odrzucał żądania z niespójnym fingerprint).
    const instance = gotScraping.extend({
        cookieJar,
        timeout: { request: 60000 }, // 60s timeout
        retry: { limit: 0 },         // bez retry — OAuth flow jest stanowy
        agent,
        useHeaderGenerator: false,   // stałe nagłówki przez całą sesję
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "application/json, text/html, */*",
            "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept-Encoding": "identity",
            "Referer": "https://portal.librus.pl/rodzina/synergia/loguj",
        },
    });

    // Wrapper, który udaje API Axios'a (get, post) dla kompatybilności z resztą kodu
    const axiosLikeWrapper = {
        get: async (url, config = {}) => {
            const options = prepareOptions(config);
            try {
                const response = await instance.get(url, options);
                return formatResponse(response);
            } catch (error) {
                throw formatError(error);
            }
        },
        post: async (url, data, config = {}) => {
            const options = prepareOptions(config);
            
            // Obsługa danych (URLSearchParams, JSON, string)
            if (data instanceof URLSearchParams) {
                options.body = data.toString();
                if (!options.headers) options.headers = {};
                options.headers['content-type'] = 'application/x-www-form-urlencoded';
            } else if (typeof data === 'object' && data !== null) {
                options.json = data;
            } else {
                options.body = data;
            }

            try {
                const response = await instance.post(url, options);
                return formatResponse(response);
            } catch (error) {
                throw formatError(error);
            }
        }
    };

    return axiosLikeWrapper;
}

// Pomocnicza funkcja do formatowania odpowiedzi jak w Axios
function formatResponse(response) {
    let data = response.body;
    // Próbujemy parsować JSON jeśli to string
    try {
        if (typeof data === 'string' && (data.trim().startsWith('{') || data.trim().startsWith('['))) {
            data = JSON.parse(data);
        }
    } catch (e) { /* ignore */ }

    return {
        data,
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
        request: response.request
    };
}

// Pomocnicza funkcja do formatowania błędów jak w Axios
function formatError(error) {
    if (error.response) {
        error.response.data = error.response.body;
        try { 
            if (typeof error.response.body === 'string') {
                error.response.data = JSON.parse(error.response.body); 
            }
        } catch(e){}
        error.response.status = error.response.statusCode;
    }
    return error;
}

// Pomocnicza funkcja do mapowania opcji Axios -> Got
function prepareOptions(config) {
    const options = { ...config };
    // Mapowanie timeoutu (axios: timeout -> got: timeout.request)
    if (options.timeout && typeof options.timeout === 'number') {
        options.timeout = { request: options.timeout };
    }
    return options;
}
