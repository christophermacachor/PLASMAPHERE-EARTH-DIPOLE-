/**
 * NOAA CORS Proxy — Cloudflare Worker
 * 
 * Routes:
 *   GET /mag-7-day.json      → NOAA DSCOVR magnetometer 7-day data
 *   GET /plasma-7-day.json   → NOAA DSCOVR plasma 7-day data
 *   GET /kp.json             → NOAA Kp index
 *   GET /ace/swepam/         → ACE SWEPAM data
 *   GET /json/goes/          → GOES satellite data
 * 
 * All responses include CORS headers for macachor.org origin.
 */

const NOAA_BASE = 'https://services.swpc.noaa.gov/products';

// Allowed origins — add your domains here
const ALLOWED_ORIGINS = [
  'https://macachor.org',
  'https://www.macachor.org',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5500',
  null // Allow no-origin (curl, etc.)
];

// Route mapping: path → NOAA endpoint
const ROUTES = {
  '/mag-7-day.json': '/solar-wind/mag-7-day.json',
  '/plasma-7-day.json': '/solar-wind/plasma-7-day.json',
  '/mag-6-hour.json': '/solar-wind/mag-6-hour.json',
  '/plasma-6-hour.json': '/solar-wind/plasma-6-hour.json',
  '/mag-1-day.json': '/solar-wind/mag-1-day.json',
  '/plasma-1-day.json': '/solar-wind/plasma-1-day.json',
  '/kp.json': '/noaa-planetary-k-index-forecast.json',
  '/ace-swepam.json': '/solar-wind/ace-swepam-7-day.json',
  '/ace-mag.json': '/solar-wind/ace-mag-7-day.json',
  '/goes-xray.json': '/json/goes/primary/xrays-7-day.json',
  '/goes-proton.json': '/json/goes/primary/integral-protons-plot-6-hour.json',
  '/events.json': '/json/events.json',
  '/alerts.json': '/json/alerts.json',
  '/summary.json': '/summary.json',
};

function getCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const corsHeaders = getCorsHeaders(origin);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Only allow GET/HEAD
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }

    // Get the route
    const path = url.pathname;
    const noaaEndpoint = ROUTES[path];

    if (!noaaEndpoint) {
      return new Response(JSON.stringify({
        error: 'Unknown endpoint',
        available: Object.keys(ROUTES),
        message: 'NOAA CORS Proxy — Macachor Absolute Scalar Field'
      }), {
        status: 404,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }

    // Build NOAA URL
    const noaaUrl = `${NOAA_BASE}${noaaEndpoint}`;

    try {
      // Fetch from NOAA with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const noaaResponse = await fetch(noaaUrl, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Macachor-Absolute-Scalar-Proxy/1.0',
        },
      });

      clearTimeout(timeout);

      if (!noaaResponse.ok) {
        throw new Error(`NOAA returned ${noaaResponse.status}`);
      }

      // Get response body
      const body = await noaaResponse.text();

      // Return with CORS headers
      return new Response(body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60', // 1 minute cache
          'X-Proxy-Source': 'noaa-cors-proxy',
          'X-Proxy-Version': '1.0.0',
        },
      });

    } catch (error) {
      console.error('Proxy error:', error.message);

      return new Response(JSON.stringify({
        error: 'Proxy fetch failed',
        message: error.message,
        endpoint: noaaEndpoint,
        timestamp: new Date().toISOString(),
      }), {
        status: 502,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }
  },
};
