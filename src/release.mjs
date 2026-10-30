export const PANEL_VERSION = '2026.10.17.2';

export function coreRelease(config) {
  const coreVersion = typeof config.coreVersion === 'string' ? config.coreVersion : '';
  return {
    panelVersion: PANEL_VERSION,
    coreVersion,
    needsUpdate: coreVersion !== PANEL_VERSION,
    changes: [
      '支持可选 PANEL_TOKEN、优选接口限流；落地页可复制 Worker 订阅直链。',
      'Free CPU 保护仍需配套内核；内核版本不一致时会提示更新。',
    ],
    zipUrl: 'https://raw.githubusercontent.com/byJoey/cfnew/core-only/pages.zip',
    workerUrl: 'https://raw.githubusercontent.com/byJoey/cfnew/core-only/_worker.js',
  };
}
