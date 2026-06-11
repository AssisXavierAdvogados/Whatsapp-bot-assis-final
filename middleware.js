// Edge Middleware — roteia cada subdomínio para sua página correspondente.
// Roda antes da busca de arquivos estáticos, então funciona mesmo existindo
// um index.html na raiz (o que impede o uso de rewrites no vercel.json).
export const config = {
  matcher: '/',
};

const SUBDOMAIN_MAP = {
  'busca.': '/busca',
  'familia.': '/familia',
  'trabalhista.': '/trabalhista',
};

export default function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase();

  for (const prefix in SUBDOMAIN_MAP) {
    if (host.startsWith(prefix)) {
      const url = new URL(request.url);
      url.pathname = SUBDOMAIN_MAP[prefix];
      return new Response(null, {
        headers: { 'x-middleware-rewrite': url.toString() },
      });
    }
  }

  // Domínio principal (assisxavier.com.br): segue normalmente para o index.html.
  return new Response(null, {
    headers: { 'x-middleware-next': '1' },
  });
}
