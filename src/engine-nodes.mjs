import { isIP } from 'node:net';

/** 是否为字面量 IP（v4/v6） */
export function isValidAddress(address) {
  return isIP(address) !== 0;
}

/** 去掉 IPv6 方括号与首尾空白 */
export function normalizeNodeHost(host) {
  return String(host || '').trim().replace(/^\[([^\]]+)\]$/, '$1');
}

/** 清洗节点备注片段，供名称生成使用 */
export function processNodeAliasPart(value, fallback = 'Node') {
  let text = String(value || '').trim();
  if (!text || /^自定义优选-/i.test(text)) text = fallback;
  text = text
    .replace(/^\[([^\]]+)\]$/, '$1')
    .replace(/^https?:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\s+/g, '_');
  return text || fallback;
}

/** 由节点字段推导基础名称（不含序号） */
export function getNodeAliasBase(item) {
  const host = normalizeNodeHost(item?.ip || item?.domain || '');
  if (host && host.includes(':') && /^[0-9a-fA-F:.]+$/.test(host)) {
    return processNodeAliasPart(item?.isp || item?.name || '', 'IPv6优选');
  }
  if (host && !isValidAddress(host)) return '优选域名';
  const base = processNodeAliasPart(item?.isp || item?.name || '', 'IPv4优选');
  const colo = processNodeAliasPart(item?.colo || '', '');
  return colo ? `${base}-${colo}` : base;
}

/**
 * 创建节点命名器：同名自动加 -01、-02…
 * @param {boolean} skipNumbering 为 true 时不追加序号
 */
export function createNodeNamer(skipNumbering = false) {
  const counters = {};
  return item => {
    const base = getNodeAliasBase(item);
    if (skipNumbering) return base;
    counters[base] = (counters[base] || 0) + 1;
    return `${base}-${String(counters[base]).padStart(2, '0')}`;
  };
}
