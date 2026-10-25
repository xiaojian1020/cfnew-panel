export const PANEL_VERSION = '2026.10.17.4';

export function coreRelease(config) {
  const coreVersion = typeof config.coreVersion === 'string' ? config.coreVersion : '';
  return {
    panelVersion: PANEL_VERSION,
    coreVersion,
    needsUpdate: coreVersion !== PANEL_VERSION,
    changes: [
      '面板 2026.10.17.4：优选列表短缓存、探测并发限制、安全响应头与 /health 版本信息。',
      'Free CPU 保护仍需配套内核；内核版本不一致时会提示更新。',
    ],
    zipUrl: 'https://raw.githubusercontent.com/byJoey/cfnew/core-only/pages.zip',
    workerUrl: 'https://raw.githubusercontent.com/byJoey/cfnew/core-only/_worker.js',
  };
}
