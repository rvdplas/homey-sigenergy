// ========================================
// Sigenergy - ensure access token
// ========================================

const ACCESS_TOKEN_VAR = 'sigenergy_access_token';
const REFRESH_TOKEN_VAR = 'sigenergy_refresh_token';
const EXPIRES_AT_VAR = 'sigenergy_token_expires_at';
const TOKEN_URL = 'https://api-eu.sigencloud.com/auth/oauth/token';
const USERNAME_VAR = 'sigenergy_username';
const PASSWORD_PREPARED_VAR = 'sigenergy_password_prepared';
const DEBUG_LOG_REQUEST_VAR = 'sigenergy_debug_log_request';
const DEBUG_LOG_SENSITIVE_VAR = 'sigenergy_debug_log_sensitive';
const DEFAULT_GRANT_TYPE = 'password';
const AUTH_CLIENT_ID = 'sigen';
const AUTHORIZATION_HEADER = 'Basic c2lnZW46c2lnZW4=';

const REFRESH_MARGIN_SECONDS = 300;

// ========================================
// Homey Logic helpers
// ========================================

async function getVar(name) {
  const vars = await Homey.logic.getVariables();
  const variable = Object.values(vars).find(v => v.name === name);

  if (!variable) {
    throw new Error(`Homey Logic variabele ontbreekt: ${name}`);
  }

  return variable;
}

async function getOptionalValue(name) {
  const vars = await Homey.logic.getVariables();
  const variable = Object.values(vars).find(v => v.name === name);
  return variable ? variable.value : null;
}

async function getValue(name) {
  return (await getVar(name)).value;
}

async function setValue(name, value) {
  const variable = await getVar(name);

  await Homey.logic.updateVariable({
    id: variable.id,
    variable: { value }
  });
}

// ========================================
// Validatie helpers
// ========================================

function isPlaceholder(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === '_'
  );
}

function looksLikeToken(token) {
  if (isPlaceholder(token)) return false;
  if (typeof token !== 'string') return false;
  if (token.length < 20) return false;

  return true;
}

function expiresAtToMs(expiresAt) {
  if (isPlaceholder(expiresAt)) return null;

  if (typeof expiresAt === 'number') {
    if (!Number.isFinite(expiresAt)) return null;
    return expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  }

  if (typeof expiresAt === 'string') {
    const asNumber = Number(expiresAt);
    if (Number.isFinite(asNumber) && expiresAt.trim() !== '') {
      return asNumber > 1e12 ? asNumber : asNumber * 1000;
    }

    const parsed = Date.parse(expiresAt);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function isTokenStillValid(expiresAt) {
  const expiresAtMs = expiresAtToMs(expiresAt);
  if (expiresAtMs === null) return false;

  return Date.now() < expiresAtMs - REFRESH_MARGIN_SECONDS * 1000;
}

function requireValue(name, value) {
  if (isPlaceholder(value)) {
    throw new Error(`${name} is nog niet goed ingesteld`);
  }

  return value;
}

function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function makeRequestId() {
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rnd()}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}

// ========================================
// Token request helpers
// ========================================

function toDebugHeaders(headers, includeSensitive) {
  if (includeSensitive) return { ...headers };

  return {
    ...headers,
    Authorization: '[masked]'
  };
}

function toDebugPayload(params, includeSensitive) {
  if (includeSensitive) return { ...params };

  return {
    grant_type: params.grant_type || null,
    scope: params.scope || null,
    userDeviceId: params.userDeviceId ? String(params.userDeviceId) : null,
    username: params.username ? `${String(params.username).slice(0, 3)}***` : null,
    password: params.password ? '[masked]' : null,
    refresh_token: params.refresh_token ? '[masked]' : null
  };
}

async function requestToken(params, debugOptions) {
  const headers = {
    'Accept': '*/*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': AUTHORIZATION_HEADER,
  };

  const body = new URLSearchParams(params).toString();

  if (debugOptions && debugOptions.enabled) {
    const includeSensitive = !!debugOptions.sensitive;
    const debugHeaders = toDebugHeaders(headers, includeSensitive);
    const debugPayload = toDebugPayload(params, includeSensitive);
    const debugBody = includeSensitive ? body : new URLSearchParams(debugPayload).toString();

    console.log('[Sigenergy Debug] Outgoing request');
    console.log(`[Sigenergy Debug] method=POST url=${TOKEN_URL}`);
    console.log(`[Sigenergy Debug] headers=${JSON.stringify(debugHeaders)}`);
    console.log(`[Sigenergy Debug] payload=${JSON.stringify(debugPayload)}`);
    console.log(`[Sigenergy Debug] body=${debugBody}`);
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers,
    body
  });

  const rawBody = await response.text();

  if (!response.ok) {
    const safeParams = {
      grant_type: params.grant_type || null,
      scope: params.scope || null,
      userDeviceId: params.userDeviceId ? String(params.userDeviceId) : null,
      username: params.username ? `${String(params.username).slice(0, 3)}***` : null,
      hasPassword: !isPlaceholder(params.password),
      hasRefreshToken: !isPlaceholder(params.refresh_token)
    };

    const bodyText = isPlaceholder(rawBody) ? '<leeg>' : rawBody;
    throw new Error(`Token request mislukt: status=${response.status} body=${bodyText} params=${JSON.stringify(safeParams)}`);
  }

  let json;
  try {
    json = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(`Token response is geen geldige JSON: ${rawBody}`);
  }

  if (json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'code') && json.code !== 0) {
    throw new Error(`Token request afgewezen: code=${json.code} msg=${json.msg || 'onbekend'}`);
  }

  let data = json && typeof json === 'object' ? (json.data !== undefined ? json.data : json) : json;

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (error) {
      throw new Error(`Token response data-string kon niet geparsed worden: ${data}`);
    }
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Token response bevat geen bruikbaar data-object');
  }

  const normalized = {
    ...data,
    access_token: data.access_token || data.accessToken || null,
    refresh_token: data.refresh_token || data.refreshToken || null,
    expires_in: data.expires_in || data.expiresIn || null
  };

  return normalized;
}

async function requestTokenWithRefreshToken(refreshToken, debugOptions) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  };

  return await requestToken(params, debugOptions);
}

async function requestTokenWithPassword(username, password, grantType, debugOptions) {
  const params = {
    grant_type: grantType,
    username,
    password
  };

  return await requestToken(params, debugOptions, { useJson: false });
}

function validateRequiredForPasswordFlow(scope, userDeviceId) {
  if (isPlaceholder(scope)) {
    throw new Error(`${SCOPE_VAR} is nog niet goed ingesteld`);
  }

  if (isPlaceholder(userDeviceId)) {
    throw new Error(`${USER_DEVICE_ID_VAR} is nog niet goed ingesteld`);
  }
}

function getExpiresAtIso(json) {
  if (json.expires_in !== undefined && json.expires_in !== null) {
    const expiresIn = Number(json.expires_in);
    const safeExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 86399;
    return new Date(Date.now() + safeExpiresIn * 1000).toISOString();
  }

  if (json.expires_at) {
    const ms = expiresAtToMs(json.expires_at);
    if (ms !== null) return new Date(ms).toISOString();
  }

  if (json.expiresAt) {
    const ms = expiresAtToMs(json.expiresAt);
    if (ms !== null) return new Date(ms).toISOString();
  }

  return new Date(Date.now() + 86399 * 1000).toISOString();
}

function buildFailureResult(error) {
  return {
    success: false,
    refreshed: false,
    method: 'failed',
    error: error.message,
    hints: [
      'Controleer of sigenergy_user_device_id exact overeenkomt met je actieve app-sessie',
      'Controleer of username exact het login-formaat gebruikt (mail/telefoon) zoals in de app',
      'Leeg eventueel sigenergy_access_token, sigenergy_refresh_token en sigenergy_token_expires_at voor een schone eerste login'
    ]
  };
}

async function ensureAccessToken() {
  // ========================================
  // Huidige token controleren
  // ========================================

  const currentAccessToken = await getOptionalValue(ACCESS_TOKEN_VAR);
  const currentExpiresAt = await getOptionalValue(EXPIRES_AT_VAR);

  if (looksLikeToken(currentAccessToken) && isTokenStillValid(currentExpiresAt)) {
    console.log('Sigenergy access token is nog geldig');
    console.log(`Verloopt op: ${currentExpiresAt}`);

    return {
      success: true,
      refreshed: false,
      method: 'existing_token',
      expiresAt: currentExpiresAt
    };
  }

  console.log('Sigenergy access token ontbreekt, lijkt ongeldig of is bijna verlopen');

  // ========================================
  // Nieuw token ophalen
  // ========================================

  const username = requireValue(USERNAME_VAR, await getValue(USERNAME_VAR));
  const password = requireValue(PASSWORD_PREPARED_VAR, await getValue(PASSWORD_PREPARED_VAR));

  const grantType = DEFAULT_GRANT_TYPE;
  const scope = null;
  const userDeviceId = null;
  const debugLogRequest = parseBool(await getOptionalValue(DEBUG_LOG_REQUEST_VAR));
  const debugLogSensitive = parseBool(await getOptionalValue(DEBUG_LOG_SENSITIVE_VAR));
  const debugOptions = {
    enabled: debugLogRequest,
    sensitive: debugLogSensitive
  };

  if (debugOptions.enabled) {
    console.log(`[Sigenergy Debug] request logging aan, sensitive=${debugOptions.sensitive}`);
    console.log(`[Sigenergy Debug] password source=${PASSWORD_PREPARED_VAR}`);
  }

  // validateRequiredForPasswordFlow(scope, userDeviceId);

  let json;
  let method;

  // const refreshToken = await getOptionalValue(REFRESH_TOKEN_VAR);
  // Refresh flow tijdelijk uitgezet voor strikte parity met Postman testconfig.
  console.log('Nieuw access_token ophalen via username/password login');
  json = await requestTokenWithPassword(username, password, scope, userDeviceId, grantType, debugOptions);
  method = 'password';

  // ========================================
  // Response valideren en opslaan
  // ========================================

  if (!looksLikeToken(json.access_token)) {
    throw new Error('Sigenergy gaf geen geldig access_token terug');
  }

  await setValue(ACCESS_TOKEN_VAR, json.access_token);

  if (json.refresh_token && !isPlaceholder(json.refresh_token)) {
    await setValue(REFRESH_TOKEN_VAR, json.refresh_token);
    console.log('Nieuwe refresh_token opgeslagen');
  }

  const expiresAt = getExpiresAtIso(json);
  await setValue(EXPIRES_AT_VAR, expiresAt);

  console.log('Sigenergy access token opgeslagen');
  console.log(`Methode: ${method}`);
  console.log(`Verloopt op: ${expiresAt}`);

  return {
    success: true,
    refreshed: true,
    method,
    expiresAt
  };
}

try {
  return await ensureAccessToken();
} catch (error) {
  console.error(`Token manager error: ${error.message}`);
  return buildFailureResult(error);
}
