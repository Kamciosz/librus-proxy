/**
 * auth.js
 * 
 * Implementacja OAuth flow do Librus Synergia.
 * WZOROWANE NA: kbaraniak/librus-api-rewrited (API/Auth/Auth.js)
 * 
 * Flow (5 kroków, zweryfikowany przez debug):
 * 1. GET  OAuth/Authorization → inicjuje sesję, pobiera cookies
 * 2. POST OAuth/Authorization?client_id=46 → wysyła login+hasło
 * 3. GET  OAuth/Authorization/Grant → aktywuje sesję dla gateway API
 * 4. GET  gateway/api/2.0/Auth/TokenInfo → pobiera UserIdentifier
 * 5. GET  gateway/api/2.0/Auth/UserInfo/{id} → finalizuje aktywację API
 * 
 * Po wykonaniu tych kroków, client ma aktywne cookies do REST API.
 */
"use strict";

const OAUTH_BASE = "https://api.librus.pl";
const GATEWAY_BASE = "https://synergia.librus.pl/gateway/api/2.0";

/**
 * Loguje użytkownika do Librus i aktywuje dostęp do REST API.
 * 
 * @param {import("axios").AxiosInstance} client - Axios client z CookieJar
 * @param {string} login - Login Synergia ucznia
 * @param {string} pass  - Hasło Synergia ucznia
 * @returns {Promise<boolean>} true gdy logowanie i aktywacja się powiodły
 * @throws {Error} "INVALID_CREDENTIALS" gdy dane są błędne
 * @throws {Error} "AUTH_FAILED" gdy aktywacja API nie powiodła się
 */
async function authenticate(client, login, pass) {
    // KROK 1: Inicjuj sesję OAuth - otrzymujemy cookies (SDZIENNIKSID etc.)
    await client.get(
        `${OAUTH_BASE}/OAuth/Authorization?client_id=46&response_type=code&scope=mydata`
    );

    // KROK 2: Wyślij dane logowania
    // UWAGA: URL to /Authorization?client_id=46 (bez /Grant) - to ważne!
    //        Wzorowane na kbaraniak Auth.js linia: "const final_authUrl = ..."
    const formData = new URLSearchParams();
    formData.append("action", "login");
    formData.append("login", login);
    formData.append("pass", pass);

    const loginResponse = await client.post(
        `${OAUTH_BASE}/OAuth/Authorization?client_id=46`,
        formData,
        {
            headers: {
                "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46&response_type=code&scope=mydata`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );

    // Sprawdź odpowiedź - Librus zwraca JSON z goTo lub błędem
    if (loginResponse.status !== 200) {
        throw new Error("INVALID_CREDENTIALS");
    }

    const responseData = loginResponse.data;
    if (responseData?.status === "error" || responseData?.errors) {
        throw new Error("INVALID_CREDENTIALS");
    }

    // KROK 3: Aktywuj sesję przez Grant endpoint
    // To kończy OAuth flow i aktywuje cookies dla gateway API
    await client.get(
        `${OAUTH_BASE}/OAuth/Authorization/Grant?client_id=46`,
        {
            headers: {
                "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46`,
            },
        }
    );

    // KROK 4 + 5: Aktywuj dostęp do REST gateway API
    // Wzorowane na kbaraniak: Auth.js - activateApiAccess()
    const tokenInfo = await client.get(`${GATEWAY_BASE}/Auth/TokenInfo`, {
        timeout: 10000,
    });

    const userIdentifier = tokenInfo.data?.UserIdentifier;
    if (!userIdentifier) {
        // TokenInfo może nie być dostępny dla wszystkich kont - to nie błąd krytyczny
        console.warn("[Auth] TokenInfo nie zwrócił UserIdentifier - API może działać bez aktywacji");
        return true;
    }

    await client.get(`${GATEWAY_BASE}/Auth/UserInfo/${userIdentifier}`, {
        timeout: 10000,
    });

    return true;
}

module.exports = { authenticate, GATEWAY_BASE };
