/**
 * auth.js
 * 
 * Implementacja OAuth flow do Librus Synergia.
 */

export const OAUTH_BASE = "https://api.librus.pl";
export const GATEWAY_BASE = "https://synergia.librus.pl/gateway/api/2.0";

/**
 * Loguje użytkownika do Librus i aktywuje dostęp do REST API.
 * 
 * @param {import("axios").AxiosInstance} client - Axios client z CookieJar
 * @param {string} login - Login Synergia ucznia
 * @param {string} pass  - Hasło Synergia ucznia
 * @returns {Promise<boolean>} true gdy logowanie i aktywacja się powiodły
 */
export async function authenticate(client, login, pass) {
    // KROK 1: Inicjuj sesję OAuth - otrzymujemy cookies (SDZIENNIKSID etc.)
    await client.get(
        `${OAUTH_BASE}/OAuth/Authorization?client_id=46&response_type=code&scope=mydata`
    );

    // KROK 2: Wyślij dane logowania
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
    await client.get(
        `${OAUTH_BASE}/OAuth/Authorization/Grant?client_id=46`,
        {
            headers: {
                "Referer": `${OAUTH_BASE}/OAuth/Authorization?client_id=46`,
            },
        }
    );

    // KROK 4 + 5: Aktywuj dostęp do REST gateway API
    let tokenInfo;
    try {
        tokenInfo = await client.get(`${GATEWAY_BASE}/Auth/TokenInfo`, {
            timeout: 10000,
        });
    } catch (err) {
        console.error("[Auth] TokenInfo request failed:", err.message, "status:", err.response?.status);
        throw new Error("AUTH_FAILED");
    }

    console.log("[Auth] TokenInfo response status:", tokenInfo.status, "data:", JSON.stringify(tokenInfo.data));

    const userIdentifier = tokenInfo.data?.UserIdentifier;
    if (!userIdentifier) {
        console.error("[Auth] TokenInfo nie zwrócił UserIdentifier. Dane:", JSON.stringify(tokenInfo.data));
        throw new Error("AUTH_FAILED");
    }

    await client.get(`${GATEWAY_BASE}/Auth/UserInfo/${userIdentifier}`, {
        timeout: 10000,
    });

    console.log("[Auth] Aktywacja gateway zakończona pomyślnie dla:", userIdentifier);
    return true;
}
