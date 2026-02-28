/**
 * createClient.js
 * 
 * Tworzy skonfigurowany axios client z automatycznym zarządzaniem cookies.
 * Wzorowane na kbaraniak/librus-api-rewrited (api.js).
 * 
 * Kluczowe: axios-cookiejar-support automatycznie przechowuje i wysyła cookies
 * między requestami - dzięki temu sesja OAuth jest utrzymywana.
 * 
 * Nagłówki:
 *  - Referer: WYMAGANY od Nov 2025 (odkrycie z PR #81 Mati365/librus-api)
 *  - User-Agent: Chrome 131 (Linux) - taki sam jak kbaraniak
 *  - Accept-Encoding: identity - zapobiega gzip który utrudnia parsowanie
 */
"use strict";

const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");

/**
 * Tworzy nowy axios client z własnym CookieJar.
 * Każde logowanie powinno używać oddzielnego client'a.
 * 
 * @returns {import("axios").AxiosInstance} Skonfigurowany axios client
 */
function createClient() {
    const jar = new CookieJar();

    const client = wrapper(
        axios.create({
            jar,
            withCredentials: true,
            maxRedirects: 5,
            timeout: 30000,
            headers: {
                // Identyczny User-Agent jak w kbaraniak/librus-api-rewrited
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                // Referer WYMAGANY - bez niego TLS handshake do api.librus.pl zawiesza się
                // Źródło: PR #81 do Mati365/librus-api (fix z Nov 2025)
                "Referer": "https://portal.librus.pl/rodzina/synergia/loguj",
                // Unikamy gzip żeby nie musieć dekodować ręcznie w Node.js
                "Accept-Encoding": "identity",
                "Accept-Language": "pl,en-US;q=0.7,en;q=0.3",
            },
        })
    );

    return client;
}

module.exports = { createClient };
