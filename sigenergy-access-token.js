// ========================================
// Sigenergy - ensure access token
// ========================================

const TOKEN_URL = 'https://api-eu.sigencloud.com/auth/oauth/token';
const AUTHORIZATION_HEADER = 'Basic c2lnZW46c2lnZW4=';
const REFRESH_MARGIN_SECONDS = 300;

const ACCESS_TOKEN_VAR = 'sigenergy_access_token';
const REFRESH_TOKEN_VAR = 'sigenergy_refresh_token';
const EXPIRES_AT_VAR = 'sigenergy_token_expires_at';
const USERNAME_VAR = 'sigenergy_username';
const PASSWORD_PREPARED_VAR = 'sigenergy_password_prepared';
const DEBUG_LOG_REQUEST_VAR = 'sigenergy_debug_log_request';
const DEBUG_LOG_SENSITIVE_VAR = 'sigenergy_debug_log_sensitive';

// ========================================
// Homey Logic
// ========================================

async function getVariable(name, required = true) {
  const variables = await Homey.logic.getVariables();
  const variable = Object.values(variables).find(
    item => item.name === name
  );

  if (!variable && required) {
    throw new Error(`Homey Logic variabele ontbreekt: ${name}`);
  }

  return variable || null;
}

async function getValue(name, required = true) {
  const variable = await getVariable(name, required);
  return variable ? variable.value : null;
}

async function setValue(name, value) {
  const variable = await getVariable(name);

  await Homey.logic.updateVariable({
    id: variable.id,
    variable: { value }
  });
}

// ========================================
// Validatie
// ========================================

function isEmpty(value) {
  return (
    value === undefined ||
    value === null ||
    (
      typeof value === 'string' &&
      (value.trim() === '' || value.trim() === '_')
    )
  );
}

function requireValue(name, value) {
  if (isEmpty(value)) {
    throw new Error(`${name} is nog niet goed ingesteld`);
  }

  return value;
}

function looksLikeToken(token) {
  return (
    typeof token === 'string' &&
    token.trim().length >= 20
  );
}

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value !== 'string') {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(
    value.trim().toLowerCase()
  );
}

function expiresAtToMs(expiresAt) {
  if (isEmpty(expiresAt)) {
    return null;
  }

  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt)) {
      return null;
    }

    return expiresAt > 1e12
      ? expiresAt
      : expiresAt * 1000;
  }

  if (typeof expiresAt === 'string') {
    const trimmed = expiresAt.trim();
    const numericValue = Number(trimmed);

    if (trimmed !== '' && Number.isFinite(numericValue)) {
      return numericValue > 1e12
        ? numericValue
        : numericValue * 1000;
    }

    const parsedDate = Date.parse(trimmed);

    return Number.isNaN(parsedDate)
      ? null
      : parsedDate;
  }

  return null;
}

function isTokenStillValid(expiresAt) {
  const expiresAtMs = expiresAtToMs(expiresAt);

  if (expiresAtMs === null) {
    return false;
  }

  return (
    Date.now() <
    expiresAtMs - REFRESH_MARGIN_SECONDS * 1000
  );
}

// ========================================
// Tokenaanvragen
// ========================================

function maskRequestPayload(params, includeSensitive) {
  if (includeSensitive) {
    return { ...params };
  }

  return {
    grant_type: params.grant_type || null,
    username: params.username
      ? `${String(params.username).slice(0, 3)}***`
      : null,
    password: params.password
      ? '[masked]'
      : null,
    refresh_token: params.refresh_token
      ? '[masked]'
      : null
  };
}

async function requestToken(params, debugOptions) {
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: AUTHORIZATION_HEADER
  };

  const body = new URLSearchParams(params).toString();

  if (debugOptions.enabled) {
    const debugHeaders = {
      ...headers,
      Authorization: debugOptions.sensitive
        ? headers.Authorization
        : '[masked]'
    };

    const debugPayload = maskRequestPayload(
      params,
      debugOptions.sensitive
    );

    console.log('[Sigenergy Debug] Uitgaande tokenaanvraag');
    console.log(`[Sigenergy Debug] POST ${TOKEN_URL}`);
    console.log(
      `[Sigenergy Debug] headers=${JSON.stringify(debugHeaders)}`
    );
    console.log(
      `[Sigenergy Debug] payload=${JSON.stringify(debugPayload)}`
    );
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers,
    body
  });

  const rawBody = await response.text();

  if (!response.ok) {
    throw new Error(
      `Token request mislukt: status=${response.status} ` +
      `body=${rawBody || '<leeg>'}`
    );
  }

  let json;

  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new Error(
      `Token response is geen geldige JSON: ${rawBody}`
    );
  }

  if (
    json &&
    typeof json === 'object' &&
    Object.prototype.hasOwnProperty.call(json, 'code') &&
    json.code !== 0
  ) {
    throw new Error(
      `Token request afgewezen: code=${json.code} ` +
      `msg=${json.msg || 'onbekend'}`
    );
  }

  let data = json?.data ?? json;

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error(
        `Token response data-string kon niet worden verwerkt: ${data}`
      );
    }
  }

  if (!data || typeof data !== 'object') {
    throw new Error(
      'Token response bevat geen bruikbaar data-object'
    );
  }

  return {
    ...data,
    access_token:
      data.access_token ||
      data.accessToken ||
      null,
    refresh_token:
      data.refresh_token ||
      data.refreshToken ||
      null,
    expires_in:
      data.expires_in ??
      data.expiresIn ??
      null
  };
}

function requestTokenWithRefreshToken(
  refreshToken,
  debugOptions
) {
  return requestToken(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    },
    debugOptions
  );
}

function requestTokenWithPassword(
  username,
  password,
  debugOptions
) {
  return requestToken(
    {
      grant_type: 'password',
      username,
      password
    },
    debugOptions
  );
}

// ========================================
// Token opslaan
// ========================================

function getExpiresAtIso(tokenResponse) {
  const expiresIn = Number(tokenResponse.expires_in);

  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();
  }

  const suppliedExpiry =
    tokenResponse.expires_at ??
    tokenResponse.expiresAt;

  const suppliedExpiryMs =
    expiresAtToMs(suppliedExpiry);

  if (suppliedExpiryMs !== null) {
    return new Date(suppliedExpiryMs).toISOString();
  }

  return new Date(
    Date.now() + 86399 * 1000
  ).toISOString();
}

async function saveTokenResponse(tokenResponse) {
  if (!looksLikeToken(tokenResponse.access_token)) {
    throw new Error(
      'Sigenergy gaf geen geldig access_token terug'
    );
  }

  await setValue(
    ACCESS_TOKEN_VAR,
    tokenResponse.access_token
  );

  if (looksLikeToken(tokenResponse.refresh_token)) {
    await setValue(
      REFRESH_TOKEN_VAR,
      tokenResponse.refresh_token
    );

    console.log('Nieuwe refresh_token opgeslagen');
  }

  const expiresAt = getExpiresAtIso(tokenResponse);

  await setValue(
    EXPIRES_AT_VAR,
    expiresAt
  );

  return expiresAt;
}

// ========================================
// Hoofdflow
// ========================================

async function ensureAccessToken() {
  const currentAccessToken = await getValue(
    ACCESS_TOKEN_VAR,
    false
  );

  const currentExpiresAt = await getValue(
    EXPIRES_AT_VAR,
    false
  );

  if (
    looksLikeToken(currentAccessToken) &&
    isTokenStillValid(currentExpiresAt)
  ) {
    console.log(
      `Sigenergy access token is nog geldig tot ${currentExpiresAt}`
    );

    return {
      success: true,
      refreshed: false,
      method: 'existing_token',
      expiresAt: currentExpiresAt
    };
  }

  console.log(
    'Access token ontbreekt, is ongeldig of verloopt bijna'
  );

  const debugOptions = {
    enabled: parseBoolean(
      await getValue(DEBUG_LOG_REQUEST_VAR, false)
    ),
    sensitive: parseBoolean(
      await getValue(DEBUG_LOG_SENSITIVE_VAR, false)
    )
  };

  if (debugOptions.enabled) {
    console.log(
      `[Sigenergy Debug] request logging aan, ` +
      `sensitive=${debugOptions.sensitive}`
    );
  }

  const refreshToken = await getValue(
    REFRESH_TOKEN_VAR,
    false
  );

  if (looksLikeToken(refreshToken)) {
    try {
      console.log(
        'Nieuw access token ophalen via refresh_token'
      );

      const tokenResponse =
        await requestTokenWithRefreshToken(
          refreshToken,
          debugOptions
        );

      const expiresAt =
        await saveTokenResponse(tokenResponse);

      console.log(
        `Sigenergy access token vernieuwd tot ${expiresAt}`
      );

      return {
        success: true,
        refreshed: true,
        method: 'refresh_token',
        expiresAt
      };
    } catch (error) {
      console.log(
        `Refresh token geweigerd, terugvallen op login: ` +
        error.message
      );
    }
  }

  const username = requireValue(
    USERNAME_VAR,
    await getValue(USERNAME_VAR, false)
  );

  const password = requireValue(
    PASSWORD_PREPARED_VAR,
    await getValue(PASSWORD_PREPARED_VAR, false)
  );

  console.log(
    'Nieuw access token ophalen via username/password login'
  );

  const tokenResponse =
    await requestTokenWithPassword(
      username,
      password,
      debugOptions
    );

  const expiresAt =
    await saveTokenResponse(tokenResponse);

  console.log(
    `Sigenergy access token opgeslagen tot ${expiresAt}`
  );

  return {
    success: true,
    refreshed: true,
    method: 'password',
    expiresAt
  };
}

function buildFailureResult(error) {
  return {
    success: false,
    refreshed: false,
    method: 'failed',
    error: error.message,
    hints: [
      'Controleer of sigenergy_username overeenkomt met de login in de app',
      'Controleer of sigenergy_password_prepared nog de juiste waarde bevat',
      'Leeg bij aanhoudende problemen sigenergy_access_token, sigenergy_refresh_token en sigenergy_token_expires_at'
    ]
  };
}

try {
  return await ensureAccessToken();
} catch (error) {
  console.error(
    `Token manager error: ${error.message}`
  );

  return buildFailureResult(error);
}
