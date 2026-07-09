// ========================================
// Sigenergy - temporary steering manager
// ========================================

const STEER_URL = 'https://api-eu.sigencloud.com/device/energy-profile/instant/manunal';
const ACCESS_TOKEN_VAR = 'sigenergy_access_token';
const STATION_ID_VAR = 'sigenergy_station_id';
const PROFILE_ARG = 'profile';
const DURATION_ARG = 'duration_minutes';
const POWER_LIMIT_ARG = 'power_limitation_kw';

const AUTH_CLIENT_ID = 'sigen';

function normalizeArgName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function addKeyValue(out, keyRaw, valueRaw) {
  const key = normalizeArgName(keyRaw);
  if (!key) return;
  out[key] = valueRaw == null ? '' : String(valueRaw).trim();
}

function tryParseJsonObject(text) {
  if (!text) return null;

  const attempt = String(text).trim();
  if (!attempt) return null;

  try {
    const parsed = JSON.parse(attempt);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_err) {
    // Ignore and continue with alternate parsing.
  }

  return null;
}

function parseJsonObjectIntoMap(out, text) {
  const parsedDirect = tryParseJsonObject(text);
  if (parsedDirect) {
    for (const [key, value] of Object.entries(parsedDirect)) {
      addKeyValue(out, key, value);
    }
    return true;
  }

  // Homey can wrap JSON payloads in quotes, e.g. "{\"profile\":\"hold_battery\"}".
  const raw = String(text || '').trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    const unwrapped = raw.slice(1, -1).trim();
    const parsedWrapped = tryParseJsonObject(unwrapped);

    if (parsedWrapped) {
      for (const [key, value] of Object.entries(parsedWrapped)) {
        addKeyValue(out, key, value);
      }
      return true;
    }
  }

  return false;
}

function parseStringArg(out, raw) {
  const text = String(raw || '').trim();
  if (!text) return;

  if (parseJsonObjectIntoMap(out, text)) {
    return;
  }

  const parts = text.split(/[\s,;]+/).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    addKeyValue(out, part.slice(0, eq), part.slice(eq + 1));
  }
}

function toArgMap(rawArgs) {
  const out = {};

  if (!rawArgs) return out;

  if (Array.isArray(rawArgs)) {
    for (const entry of rawArgs) {
      if (entry == null) continue;

      if (typeof entry === 'string') {
        parseStringArg(out, entry);
        continue;
      }

      if (typeof entry === 'object') {
        for (const [key, value] of Object.entries(entry)) {
          addKeyValue(out, key, value);
        }
      }
    }

    return out;
  }

  if (typeof rawArgs === 'string') {
    parseStringArg(out, rawArgs);
    return out;
  }

  if (typeof rawArgs === 'object') {
    for (const [key, value] of Object.entries(rawArgs)) {
      addKeyValue(out, key, value);
    }
  }

  return out;
}

const argMap = toArgMap(typeof args !== 'undefined' ? args : null);

function getArg(...names) {
  for (const name of names) {
    const normalized = normalizeArgName(name);
    if (Object.prototype.hasOwnProperty.call(argMap, normalized)) {
      const value = argMap[normalized];
      if (!isPlaceholder(value)) return value;
    }
  }
  return null;
}

function isPlaceholder(value) {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    value === '_'
  );
}

async function getVar(name) {
  const vars = await Homey.logic.getVariables();
  const variable = Object.values(vars).find(v => v.name === name);
  if (!variable) throw new Error(`Homey Logic variabele ontbreekt: ${name}`);
  return variable;
}

async function getValue(name) {
  return (await getVar(name)).value;
}

async function getOptionalValue(name) {
  const vars = await Homey.logic.getVariables();
  const variable = Object.values(vars).find(v => v.name === name);
  return variable ? variable.value : null;
}

function requireValue(name, value) {
  if (isPlaceholder(value)) {
    throw new Error(`${name} is nog niet goed ingesteld`);
  }
  return value;
}

function makeRequestId() {
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${rnd()}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd().slice(0, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}

function makeSigHeaders(token, jsonContentType = false) {
  const requiredToken = requireValue(ACCESS_TOKEN_VAR, token);
  const nowTs = String(Date.now());
  return {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9,nl;q=0.8',
    'Auth-Client-Id': AUTH_CLIENT_ID,
    'Authorization': `bearer ${requiredToken}`,
    'Cache-Control': 'no-cache',
    'Client-Server': 'eu',
    'Content-Type': jsonContentType ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded',
    'Lang': 'en_US',
    'Origin': 'https://app-eu.sigencloud.com',
    'Pragma': 'no-cache',
    'Referer': 'https://app-eu.sigencloud.com/',
    'Sg-Bui': '1',
    'Sg-Env': '1',
    'Sg-Log-Id': makeRequestId(),
    'Sg-Pkg': 'sigen_app',
    'Sg-Platform': 'web',
    'Sg-Session': makeRequestId(),
    'Sg-Ts': nowTs,
    'Sg-V': '3.5.2',
    'Version': 'RELEASE',
  };
}

function validateDurationMinutes(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1440) {
    throw new Error(`${DURATION_ARG} moet een integer zijn tussen 1 en 1440`);
  }
  return String(n);
}

function validatePowerLimitationKw(value) {
  if (isPlaceholder(value)) return null;

  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${POWER_LIMIT_ARG} moet een getal in kW zijn (>= 0)`);
  }

  return String(n);
}

function normalizeProfile(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function buildSteeringPayload(stationId, profile, duration, powerOverride) {
  const profileMap = {
    charging: { mode: '0', defaultPower: '4294967.295' },
    discharging: { mode: '1', defaultPower: '1' },
    hold_battery: { mode: '2', defaultPower: '' },
    self_consumption: { mode: '3', defaultPower: '' },
  };

  if (profile === 'stop') {
    return {
      enable: false,
      stationId,
      mode: '',
      duration: '',
      powerLimitation: '',
    };
  }

  const selected = profileMap[profile];
  if (!selected) {
    throw new Error(`${PROFILE_ARG} ongeldig. Gebruik: charging | discharging | hold_battery | self_consumption | stop`);
  }

  return {
    enable: true,
    stationId,
    mode: selected.mode,
    duration,
    powerLimitation: isPlaceholder(powerOverride) ? selected.defaultPower : String(powerOverride),
  };
}

async function sendSteering(accessToken, payload) {
  const response = await fetch(STEER_URL, {
    method: 'PUT',
    headers: makeSigHeaders(accessToken, true),
    body: JSON.stringify(payload),
  });

  const rawBody = await response.text();
  let json;
  try {
    json = JSON.parse(rawBody);
  } catch (_err) {
    json = { raw: rawBody };
  }

  if (!response.ok) {
    throw new Error(`Steering request mislukt: ${response.status} ${rawBody}`);
  }

  if (Object.prototype.hasOwnProperty.call(json, 'code') && json.code !== 0) {
    throw new Error(`Steering request afgewezen: code=${json.code} msg=${json.msg || 'onbekend'}`);
  }

  return json;
}

const stationId = Number(requireValue(
  STATION_ID_VAR,
  getArg('station_id', 'sigenergy_station_id') ?? await getValue(STATION_ID_VAR)
));
if (!Number.isInteger(stationId)) {
  throw new Error(`${STATION_ID_VAR} moet een integer zijn`);
}

const profile = normalizeProfile(requireValue(
  PROFILE_ARG,
  getArg('profile', 'steer_profile', 'sigenergy_steer_profile')
));
const duration = validateDurationMinutes(
  requireValue(
    DURATION_ARG,
    getArg('duration', 'duration_minutes', 'steer_duration_minutes', 'sigenergy_steer_duration_minutes')
  )
);
const powerLimitationRaw = getArg(
  'power_limitation_kw',
  'power_limitation_kws',
  'power_limitation',
  'steer_power_limitation',
  'sigenergy_steer_power_limitation'
);
const powerLimitationOverride = validatePowerLimitationKw(powerLimitationRaw);

const accessToken = requireValue(
  ACCESS_TOKEN_VAR,
  getArg('access_token', 'sigenergy_access_token') ?? await getValue(ACCESS_TOKEN_VAR)
);
const payload = buildSteeringPayload(stationId, profile, duration, powerLimitationOverride);

console.log(`Sigenergy steering profile: ${profile}`);
console.log(`Sigenergy steering args: ${JSON.stringify(argMap)}`);
console.log(`Sigenergy steering endpoint: ${STEER_URL}`);

const response = await sendSteering(accessToken, payload);

console.log('Sigenergy temporary steering uitgevoerd');

return {
  success: true,
  endpoint: STEER_URL,
  profile,
  payload,
  response,
};
