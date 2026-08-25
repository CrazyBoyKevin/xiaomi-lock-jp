export function assertLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    throw new Response('This control API is available on localhost only.', { status: 403 });
  }

  const origin = request.headers.get('origin');
  if (origin) {
    const originHost = new URL(origin).hostname.toLowerCase();
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(originHost)) {
      throw new Response('Cross-origin control requests are blocked.', { status: 403 });
    }
  }
}
