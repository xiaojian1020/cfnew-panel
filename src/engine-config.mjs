// 配置与环境辅助：从 engine.mjs 的 createSubscriptionEngine 闭包顶部抽出。
// 这里的函数不依赖闭包可变状态；原先读取闭包 键值配置 的
// getEffectiveConfigSnapshot 改为由调用方把 KV 配置作为参数传入。

import { SUBSCRIPTION_CONVERTER_URL } from './engine-constants.mjs';

const base64TextDecoder = new TextDecoder();

/** base64 文本 -> UTF-8 文本（原 解码64） */
export function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return base64TextDecoder.decode(bytes);
}

/** 配置项默认值（原 配置默认值） */
export const CONFIG_DEFAULTS = {
  freeCpu: 'no',
  wk: '',
  ev: 'yes',
  et: 'no',
  ex: 'no',
  ech: 'no',
  tp: '',
  customDNS: 'https://223.5.5.5/dns-query',
  customECHDomain: 'cloudflare-ech.com',
  alpn: '',
  d: '',
  p: '',
  yx: '',
  yxURL: '',
  s: '',
  homepage: '',
  scu: SUBSCRIPTION_CONVERTER_URL,
  ena: 'no',
  epd: 'yes',
  epi: 'yes',
  egi: 'yes',
  ae: '',
  rm: '',
  qj: '',
  dkby: 'no',
  yxby: '',
  ipv4: 'yes',
  ipv6: 'yes',
  ispMobile: 'yes',
  ispUnicom: 'yes',
  ispTelecom: 'yes',
  jk: 'no'
};

/** 把任意配置值解释为布尔开关（原 是否开启值） */
export function isEnabledValue(value, defaultEnabled = false) {
  if (value === undefined || value === null || value === '') return defaultEnabled;
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'yes' || text === 'true' || text === '1' || text === 'on') return true;
  if (text === 'no' || text === 'false' || text === '0' || text === 'off') return false;
  return defaultEnabled;
}

/** 把开关值归一为 'yes' / 'no'（原 归一配置开关） */
export function normalizeConfigSwitch(value, defaultEnabled = false) {
  return isEnabledValue(value, defaultEnabled) ? 'yes' : 'no';
}

/** 合并默认值并归一所有开关项（原 整理有效配置） */
export function normalizeEffectiveConfig(config) {
  const snapshot = {
    ...CONFIG_DEFAULTS,
    ...config
  };
  ['freeCpu', 'ev', 'et', 'ex', 'ech', 'ena', 'epd', 'epi', 'egi', 'ipv4', 'ipv6', 'ispMobile', 'ispUnicom', 'ispTelecom', 'jk'].forEach(key => {
    snapshot[key] = normalizeConfigSwitch(snapshot[key], isEnabledValue(CONFIG_DEFAULTS[key]));
  });
  if (snapshot.ev === 'no' && snapshot.et === 'no' && snapshot.ex === 'no') {
    snapshot.ev = 'yes';
  }
  if (snapshot.ech === 'yes') {
    snapshot.dkby = 'yes';
  }
  return snapshot;
}

/** 按名称列表依次从环境对象里取第一个非空值（原 读取环境配置值） */
export function readEnvConfigValue(env, ...names) {
  if (!env) return undefined;
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== null && env[name] !== '') {
      return env[name];
    }
  }
  return undefined;
}

/** 把环境变量（大小写两种命名）映射成配置快照（原 获取环境配置快照） */
export function getEnvConfigSnapshot(env = {}) {
  const mapping = {
    freeCpu: ['freeCpu', 'FREE_CPU'],
    wk: ['wk', 'WK'],
    ev: ['ev', 'EV'],
    et: ['et', 'ET'],
    ex: ['ex', 'EX'],
    ech: ['ech', 'ECH'],
    tp: ['tp', 'TP'],
    customDNS: ['customDNS', 'CUSTOMDNS', 'CUSTOM_DNS'],
    customECHDomain: ['customECHDomain', 'CUSTOMECHDOMAIN', 'CUSTOM_ECH_DOMAIN'],
    alpn: ['alpn', 'ALPN'],
    d: ['d', 'D'],
    p: ['p', 'P'],
    yx: ['yx', 'YX'],
    yxURL: ['yxURL', 'YXURL', 'YX_URL'],
    s: ['s', 'S'],
    homepage: ['homepage', 'HOMEPAGE'],
    scu: ['scu', 'SCU'],
    ena: ['ena', 'ENA'],
    epd: ['epd', 'EPD'],
    epi: ['epi', 'EPI'],
    egi: ['egi', 'EGI'],
    ae: ['ae', 'AE'],
    rm: ['rm', 'RM'],
    qj: ['qj', 'QJ'],
    dkby: ['dkby', 'DKBY'],
    yxby: ['yxby', 'YXBY'],
    ipv4: ['ipv4', 'IPV4'],
    ipv6: ['ipv6', 'IPV6'],
    ispMobile: ['ispMobile', 'ISPMOBILE', 'ISP_MOBILE'],
    ispUnicom: ['ispUnicom', 'ISPUNICOM', 'ISP_UNICOM'],
    ispTelecom: ['ispTelecom', 'ISPTELECOM', 'ISP_TELECOM'],
    jk: ['jk', 'JK']
  };
  const snapshot = {};
  for (const [key, names] of Object.entries(mapping)) {
    const value = readEnvConfigValue(env, ...names);
    if (value !== undefined) snapshot[key] = value;
  }
  return snapshot;
}

/** 环境快照叠加 KV 配置后归一（原 获取有效配置快照；KV 配置改为参数传入） */
export function getEffectiveConfigSnapshot(env = {}, kvConfig = {}) {
  return normalizeEffectiveConfig({
    ...getEnvConfigSnapshot(env),
    ...kvConfig
  });
}

/** 官方直连地址池（原 官方直连地址） */
export const OFFICIAL_DIRECT_ADDRESSES = ['pp.xy.kg'];

/** 随机取一个官方直连地址（原 取官方直连地址） */
export function getOfficialDirectAddress() {
  const hit = OFFICIAL_DIRECT_ADDRESSES[Math.floor(Math.random() * OFFICIAL_DIRECT_ADDRESSES.length)];
  return {
    domain: hit,
    region: 'CF',
    regionCode: 'CF',
    port: 443
  };
}

/** 从 KV 配置对象按键取值（原 获取配置值；配置对象改为参数传入） */
export function getConfigValue(kvConfig, key, defaultValue = '') {
  if (kvConfig[key] !== undefined) {
    return kvConfig[key];
  }
  return defaultValue;
}
