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

    // Instancja got-scraping z automatycznym zarządzaniem nagłówkami i TLS
    const instance = gotScraping.extend({
        cookieJar,
        timeout: { request: 60000 }, // 60s timeout
        retry: { limit: 2 },
        agent, 
        headers: {
            // Referer jest wymagany przez Librus
            "Referer": "https://portal.librus.pl/rodzina/synergia/loguj",
        },
        // Konfiguracja generatora nagłówków (udajemy Chrome/Firefox na Desktopie)
        headerGeneratorOptions: {
            browsers: [
                { name: 'chrome', minVersion: 110 },
                { name: 'firefox', minVersion: 110 }
            ],
            devices: ['desktop'],
            locales: ['pl-PL', 'en-US'],
            operatingSystems: ['windows', 'linux']
        }
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
