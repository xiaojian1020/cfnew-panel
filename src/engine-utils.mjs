// 纯函数工具：从 engine.mjs 的 createSubscriptionEngine 闭包中抽出。
// 这些函数只依赖入参，不读取也不修改闭包状态。

import { getOfficialDirectAddress } from './engine-config.mjs';

/** 归一 ALPN 值，只保留受支持的组合（原 规范化应用层协议协商） */
export function normalizeAlpn(value) {
  const supported = ['', 'h3', 'h2', 'http/1.1', 'h3,h2', 'h2,http/1.1', 'h3,h2,http/1.1'];
  const alpn = String(value || '').trim();
  return supported.includes(alpn) ? alpn : '';
}

/**
 * 解析“地址[:端口]”，兼容 [IPv6]:端口 与裸 IPv6（原 解析地址值端口）。
 * 返回 { address, port }，无端口时 port 为 null。
 */
export function parseAddressPort(input) {
  if (input.includes('[') && input.includes(']')) {
    const bracketed = input.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketed) {
      return {
        address: bracketed[1],
        port: bracketed[2] ? parseInt(bracketed[2], 10) : null
      };
    }
  }
  const colonIndex = input.lastIndexOf(':');
  if (colonIndex > 0) {
    const address = input.substring(0, colonIndex);
    const portText = input.substring(colonIndex + 1);
    const port = parseInt(portText, 10);

    // address 含 ':' 说明是裸 IPv6（如 2001:db8::1），整体当地址，无端口
    if (!address.includes(':') && !isNaN(port) && port > 0 && port <= 65535) {
      return {
        address: address,
        port: port
      };
    }
  }
  return {
    address: input,
    port: null
  };
}

/** 把值转成带双引号的字符串字面量（原 处理本地值622），供 YAML 类输出使用 */
export function quoteValueString(value) {
  if (value == null) return '""';
  const text = String(value);
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 去掉主机名两端的 IPv6 方括号（原 规范化值主机） */
export function normalizeValueHost(hostname) {
  if (!hostname) return hostname;
  const text = String(hostname);
  if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1);
  return text;
}

/** 生成 Clash 代理组 proxies 的 YAML 行（原 处理值选择值） */
export function buildProxyGroupProxiesYaml(names, options = {}) {
  const {
    directFirst = false,
    extraGroups = []
  } = options;
  const nodeLines = names.length ? names.map(name => `      - ${quoteValueString(name)}`).join('\n') : '      - DIRECT';
  const lines = [];
  if (directFirst) {
    lines.push('      - "🎯 全球直连"', '      - "🚀 节点选择"');
  } else {
    lines.push('      - "🚀 节点选择"', '      - "🎯 全球直连"');
  }
  for (const group of extraGroups) lines.push(`      - ${quoteValueString(group)}`);
  lines.push(nodeLines);
  return lines.join('\n');
}

/** 生成 Surge/Loon 类代理组的逗号分隔列表（原 处理值值列表） */
export function buildProxyGroupInlineList(names, options = {}) {
  const {
    directFirst = false,
    extraGroups = [],
    compact = false
  } = options;
  const separator = compact ? ',' : ', ';
  const joinedNames = names.length ? names.join(separator) : 'DIRECT';
  const parts = [];
  if (directFirst) parts.push('🎯 全球直连', '🚀 节点选择');else parts.push('🚀 节点选择', '🎯 全球直连');
  parts.push(...extraGroups);
  if (names.length) parts.push(joinedNames);
  return parts.join(separator);
}

/** 地区之间的备用顺序（原 获取值值） */
export function getRegionFallbacks(region) {
  const fallbackMap = {
    'US': ['SG', 'JP', 'KR'],
    'SG': ['JP', 'KR', 'US'],
    'JP': ['SG', 'KR', 'US'],
    'KR': ['JP', 'SG', 'US'],
    'DE': ['NL', 'GB', 'SE', 'FI'],
    'SE': ['DE', 'NL', 'FI', 'GB'],
    'NL': ['DE', 'GB', 'SE', 'FI'],
    'FI': ['SE', 'DE', 'NL', 'GB'],
    'GB': ['DE', 'NL', 'SE', 'FI']
  };
  return fallbackMap[region] || [];
}

/** 地区优先级：本地区、备用地区、其余已知地区（原 获取值值值值） */
export function getRegionPriorityList(region) {
  const fallbacks = getRegionFallbacks(region);
  const allRegions = ['US', 'SG', 'JP', 'KR', 'DE', 'SE', 'NL', 'FI', 'GB'];
  return [region, ...fallbacks, ...allRegions.filter(item => item !== region && !fallbacks.includes(item))];
}

/** 按地区优先级重排可用地址（原 获取值地区值；地区匹配开关改为必传参数） */
export function orderAddressesByRegionPreference(workerRegion, availableAddresses, regionMatch) {
  if (!regionMatch || !workerRegion) {
    return availableAddresses;
  }
  const priority = getRegionPriorityList(workerRegion);
  const ordered = [];
  for (const region of priority) {
    const regionAddresses = availableAddresses.filter(address => address.regionCode === region);
    ordered.push(...regionAddresses);
  }
  return ordered;
}

/** 把归一后的 ALPN 写进 URL 参数（原 处理值应用层协议协商值；当前 ALPN 改为参数传入） */
export function applyAlpnParam(params, currentAlpn) {
  const alpn = normalizeAlpn(currentAlpn);
  if (alpn) params.set('alpn', alpn);
}

/**
 * 取备用地址（原 获取值备用地址；备用池与地区匹配开关改为参数传入）。
 * 地区为空/CF 或备用池为空时走官方直连。
 */
export function pickFallbackAddress(workerRegion = '', regionMatch = true, fallbackAddresses = []) {
  // wk 留空时走官方直连域名，手填 p 仍优先。
  if (!workerRegion || workerRegion === 'CF') {
    return getOfficialDirectAddress();
  }
  if (fallbackAddresses.length === 0) {
    return getOfficialDirectAddress();
  }
  const available = fallbackAddresses.map(address => ({
    ...address,
    available: true
  }));
  if (regionMatch && workerRegion) {
    const ordered = orderAddressesByRegionPreference(workerRegion, available, regionMatch);
    if (ordered.length > 0) {
      return ordered[0];
    }
  }
  return available[0];
}
