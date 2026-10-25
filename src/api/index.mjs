import { handlePanel } from '../server.mjs';

const maxBodyBytes = 1048576;

function respond(response, method) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

export async function handleVercelRequest(request) {
  try {
    if (!['GET', 'HEAD'].includes(request.method) && request.body) {
      const chunks = []; let size = 0;
      const reader = request.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel();
          return respond(Response.json({ success: false, message: '配置过大，请减少优选条目或改用列表 URL（请求上限 1 MiB）' }, { status: 413 }), request.method);
        }
        chunks.push(value);
      }
      request = new Request(request, { body: Buffer.concat(chunks), duplex: 'half' });
    }
    return respond(await handlePanel(request), request.method);
  } catch {
    return respond(Response.json({ success: false, message: '服务暂时不可用，请稍后重试' }, { status: 500 }), request.method);
  }
}

// Vercel 托管函数入口，不监听端口，也不转发代理数据流量。
export default { fetch: handleVercelRequest };
