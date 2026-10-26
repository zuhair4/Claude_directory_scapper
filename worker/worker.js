export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      const url = new URL(request.url);
      let targetPath = url.pathname;
      if (targetPath.startsWith('/proxy')) {
        targetPath = targetPath.replace(/^\/proxy/, '');
      } else if (!targetPath.startsWith('/api')) {
        targetPath = '/api/directory/plugins';
      }

      const targetUrl = `https://api.anthropic.com${targetPath}${url.search}`;

      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Claude-Directory-Scraper-Proxy',
          Accept: 'application/json',
        },
      });

      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', '*');

      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
